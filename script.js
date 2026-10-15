/**
 * GupShup TV - Core WebRTC & Socket.io Signaling Engine
 * STUN Servers: stun:stun.l.google.com:19302, stun:stun1.l.google.com:19302
 * Features: P2P Audio/Video, Audio Mute, Video Toggle, Camera Switch, Next Stranger, Auto-Scroll
 */

// WebRTC Configuration with Google Public STUN
export const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
};

export class GupShupClient {
  constructor(options = {}) {
    this.socket = null;
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.currentPartnerId = null;
    this.currentRoomId = null;
    this.mode = 'video'; // 'video' | 'text'
    this.isMuted = false;
    this.isVideoOff = false;
    this.facingMode = 'user'; // 'user' or 'environment' for mobile flip
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onTyping = options.onTyping || (() => {});
    this.onStats = options.onStats || (() => {});
    this.onError = options.onError || (() => {});
  }

  // Initialize Socket.io connection
  initSocket(socketInstance) {
    this.socket = socketInstance;

    this.socket.on('stats:update', (data) => {
      this.onStats(data);
    });

    this.socket.on('match:waiting', (data) => {
      this.onStatusChange({ state: 'waiting', mode: data.mode, position: data.position });
    });

    this.socket.on('match:found', async (data) => {
      this.currentPartnerId = data.partnerId;
      this.currentRoomId = data.roomId;
      this.mode = data.mode;
      this.onStatusChange({ state: 'connected', partnerId: data.partnerId, isInitiator: data.isInitiator, mode: data.mode });

      if (this.mode === 'video') {
        await this.setupPeerConnection(data.isInitiator, data.partnerId);
      }
    });

    this.socket.on('signal:offer', async (payload) => {
      if (!this.peerConnection) {
        await this.setupPeerConnection(false, payload.from);
      }
      try {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.socket.emit('signal:answer', {
          to: payload.from,
          sdp: answer,
        });
      } catch (err) {
        console.error('Error handling WebRTC offer:', err);
      }
    });

    this.socket.on('signal:answer', async (payload) => {
      try {
        if (this.peerConnection) {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        }
      } catch (err) {
        console.error('Error setting remote answer:', err);
      }
    });

    this.socket.on('signal:candidate', async (payload) => {
      try {
        if (this.peerConnection && payload.candidate) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        }
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    });

    this.socket.on('chat:message', (payload) => {
      this.onMessage(payload);
    });

    this.socket.on('chat:typing', (payload) => {
      this.onTyping(payload.isTyping);
    });

    this.socket.on('partner:disconnected', (payload) => {
      this.closePeerConnection();
      this.onStatusChange({ state: 'stranger_left', message: payload.message });
    });

    this.socket.on('chat:stopped', () => {
      this.closePeerConnection();
      this.onStatusChange({ state: 'idle' });
    });
  }

  // Request user camera and microphone
  async startMedia(video = true, audio = true) {
    if (this.localStream) {
      return this.localStream;
    }
    try {
      const constraints = {
        audio: audio,
        video: video
          ? {
              facingMode: this.facingMode,
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 30, max: 30 },
            }
          : false,
      };

      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      return this.localStream;
    } catch (err) {
      console.warn('Media access error:', err);
      this.onError({
        name: err.name,
        message:
          err.name === 'NotAllowedError'
            ? 'Camera/Microphone permission denied. Please allow access in browser settings.'
            : 'Camera or microphone not detected. You can still use Text Chat mode!',
      });
      throw err;
    }
  }

  // Flip camera between front & back (especially mobile)
  async flipCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    if (!this.localStream) return;

    try {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        this.localStream.removeTrack(videoTrack);
      }

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facingMode },
      });
      const newTrack = newStream.getVideoTracks()[0];
      this.localStream.addTrack(newTrack);

      // Replace track in peer connection if active
      if (this.peerConnection) {
        const senders = this.peerConnection.getSenders();
        const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
        if (videoSender) {
          videoSender.replaceTrack(newTrack);
        }
      }
      return newTrack;
    } catch (err) {
      console.error('Failed to flip camera:', err);
      this.onError({ message: 'Unable to flip camera on this device.' });
    }
  }

  // Toggle microphone
  toggleMute() {
    if (this.localStream) {
      const audioTracks = this.localStream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.isMuted = !this.isMuted;
        audioTracks[0].enabled = !this.isMuted;
        return this.isMuted;
      }
    }
    return this.isMuted;
  }

  // Toggle video cam
  toggleVideo() {
    if (this.localStream) {
      const videoTracks = this.localStream.getVideoTracks();
      if (videoTracks.length > 0) {
        this.isVideoOff = !this.isVideoOff;
        videoTracks[0].enabled = !this.isVideoOff;
        return this.isVideoOff;
      }
    }
    return this.isVideoOff;
  }

  // WebRTC Peer Connection Setup
  async setupPeerConnection(isInitiator, partnerId) {
    this.closePeerConnection();

    this.peerConnection = new RTCPeerConnection(rtcConfig);

    // Add local tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Remote track arrival
    this.peerConnection.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        this.onRemoteStream(this.remoteStream);
      }
    };

    // ICE Candidate generation
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.socket && partnerId) {
        this.socket.emit('signal:candidate', {
          to: partnerId,
          candidate: event.candidate,
        });
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      if (state === 'failed' || state === 'disconnected') {
        console.warn('ICE connection state:', state);
      }
    };

    // Initiator creates offer
    if (isInitiator) {
      try {
        const offer = await this.peerConnection.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await this.peerConnection.setLocalDescription(offer);
        this.socket.emit('signal:offer', {
          to: partnerId,
          sdp: offer,
        });
      } catch (err) {
        console.error('Error creating offer:', err);
      }
    }
  }

  // Send text message
  sendMessage(text) {
    if (!text || !this.socket) return;
    this.socket.emit('chat:message', { text });
  }

  // Send typing indicator
  sendTyping(isTyping) {
    if (this.socket) {
      this.socket.emit('chat:typing', { isTyping });
    }
  }

  // Match / Find Stranger
  findPartner(mode = 'video', interests = []) {
    this.mode = mode;
    this.closePeerConnection();
    if (this.socket) {
      this.socket.emit('chat:find', { mode, interests });
    }
  }

  // Skip to next stranger
  skipPartner() {
    this.closePeerConnection();
    if (this.socket) {
      this.socket.emit('chat:skip', { nextMode: this.mode });
    }
  }

  // Stop chat completely
  stopChat() {
    this.closePeerConnection();
    if (this.socket) {
      this.socket.emit('chat:stop');
    }
  }

  // Report stranger
  reportStranger(reason) {
    this.closePeerConnection();
    if (this.socket) {
      this.socket.emit('chat:report', { reason });
    }
  }

  closePeerConnection() {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.remoteStream = null;
    this.currentPartnerId = null;
    this.currentRoomId = null;
  }

  stopAllMedia() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    this.closePeerConnection();
  }
}
