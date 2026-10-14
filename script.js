// Splash to App Logic - Final
window.onload = () => {
  setTimeout(() => {
    document.getElementById('splash').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('app').style.flexDirection = 'column';
  }, 3000);

  // Dummy Camera Start for Testing
  navigator.mediaDevices.getUserMedia({video:true, audio:true})
  .then(stream => {
    document.getElementById('localVideo').srcObject = stream;
  }).catch(() => {
    console.log("Camera Permission Denied - Test Mode");
  });

  // Buttons Logic
  document.getElementById('next').onclick = () => {
    document.querySelector('.searching').innerText = "Searching...";
    document.querySelector('.searching').style.display = "block";
    setTimeout(()=>{ document.querySelector('.searching').style.display="none"; }, 1500);
  };
  document.getElementById('stop').onclick = () => {
    document.querySelector('.searching').innerText = "Stopped";
  };
};

// Gender Filter Active Toggle
document.querySelectorAll('.filters button').forEach(btn=>{
  btn.onclick = () => {
    document.querySelectorAll('.filters button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  }
});