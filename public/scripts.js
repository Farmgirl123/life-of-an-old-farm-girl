// Frontend logic integrated with backend uploads to S3, YouTube, deletes, analytics, and contact form

document.addEventListener("DOMContentLoaded", () => {
  setupUploadButtons();
  initDropzones();
  loadAllSections();
  trackPageView();
  initAuthLinks();
  loadMiniStats();
  initContactForm();
});

function initAuthLinks(){
  fetch("/session").then(r=>r.json()).then(j=>{
    const el = document.getElementById("authLinks");
    if(!el) return;
    if(j.loggedIn){
      el.innerHTML = '<a href="/admin.html">Dashboard</a> | <a href="#" id="logoutLink">Logout</a>';
      const link = document.getElementById("logoutLink");
      if(link){
        link.addEventListener("click", async (e)=>{
          e.preventDefault();
          await fetch("/logout", {method:"POST"});
          location.reload();
        });
      }
    }else{
      el.innerHTML = '<a href="/login.html">Login</a>';
    }
  }).catch(()=>{});
}

// Contact form to server email route
function initContactForm(){
  const form = document.getElementById("contact-form");
  if(!form) return;
  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const name = document.getElementById("name").value.trim();
    const email = document.getElementById("email").value.trim();
    const message = document.getElementById("message").value.trim();
    const result = document.getElementById("contact-result");
    result.textContent = "Sending...";
    try{
      const res = await fetch("/contact", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ name, email, message })
      });
      const json = await res.json();
      result.textContent = json.success ? "Thanks! Your message was sent." : ("Failed: " + (json.message || ""));
      if(json.success) form.reset();
    }catch(e){
      result.textContent = "Failed to send. Please try again later.";
    }
  });
}

// --------- ANALYTICS CLIENT HELPERS ---------
function currentPageKey() {
  const p = location.pathname.replace(/^\/+/, "").replace(/\.html$/, "") || "home";
  return p;
}
async function trackPageView() {
  try {
    await fetch("/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "pageview", page: currentPageKey() })
    });
  } catch {}
}
async function trackVideoInteraction(videoType) {
  try {
    await fetch("/analytics/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "video", videoType })
    });
  } catch {}
}

async function loadMiniStats(){
  try{
    const res = await fetch("/analytics/summary");
    if(!res.ok) return;
    const { analytics } = await res.json();
    const totalViews = Object.values(analytics.pageViews || {}).reduce((a,b)=>a+b,0);
    const totalUploads = (analytics.uploads && analytics.uploads.total) || 0;
    const el = document.getElementById("mini-stats");
    if(el) el.textContent = `Total views: ${totalViews.toLocaleString()} • Total uploads: ${totalUploads}`;
  }catch{}
}

// ========== SETUP HANDLERS ========== //
function setupUploadButtons() {
  const photoInput = document.getElementById("photo-upload");
  const videoInput = document.getElementById("video-upload");
  const sponsorInput = document.getElementById("sponsor-upload");
  const ytForm = document.getElementById("youtube-form");

  if (photoInput) photoInput.addEventListener("change", (e) => handleUpload(e, "photos"));
  if (videoInput) videoInput.addEventListener("change", (e) => handleUpload(e, "videos"));
  if (sponsorInput) sponsorInput.addEventListener("change", (e) => handleUpload(e, "sponsors"));
  if (ytForm) ytForm.addEventListener("submit", addYouTubeVideo);
}

// ========== UPLOAD HANDLER (S3) ========== //
async function handleUpload(event, type) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return alert("Please select at least one file to upload.");

  for (const file of files) {
    try {
      // 1) Ask server for presigned URL
      const pres = await fetch(`/upload/presign/${type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type })
      }).then(r => r.json());

      if (!pres.success) { alert("Failed to prepare upload."); break; }

      // 2) PUT file directly to S3
      const putRes = await fetch(pres.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      });
      if (!putRes.ok) { alert("S3 upload failed."); break; }

      // 3) Notify server to save metadata
      await fetch("/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          key: pres.key,
          name: file.name,
          contentType: file.type
        })
      });

    } catch (err) {
      console.error("Upload error:", err);
      alert("Upload failed. Are you logged in?");
      break;
    }
  }
  loadSection(type);
}

// ========== LOAD SECTIONS ========== //
function loadAllSections() {
  loadSection("photos");
  loadSection("videos");
  loadSection("sponsors");
}

async function loadSection(type) {
  const res = await fetch(`/data/${type}`);
  const data = await res.json();
  switch (type) {
    case "photos": renderGallery(data); break;
    case "videos": renderVideos(data); break;
    case "sponsors": renderSponsors(data); break;
  }
}

// ========== RENDER FUNCTIONS ========== //
function renderGallery(photos = []) {
  const container = document.getElementById("gallery-grid");
  if (!container) return;
  if (photos.length === 0) {
    container.innerHTML = "<p>No photos uploaded yet.</p>";
    return;
  }
  container.innerHTML = photos.map(
    (p) => `
    <div class="gallery-item">
      <img src="${p.key ? ("/img/" + encodeURIComponent(p.key) + "?w=1000&f=webp") : p.url}" alt="${p.name}">
      <small>${new Date(p.date).toLocaleDateString()}</small><br>
      <button onclick="deleteItem('photos', '${p.id}')">Delete</button>
    </div>`
  ).join("");
}

function renderVideos(videos = []) {
  const container = document.getElementById("video-list");
  if (!container) return;
  if (videos.length === 0) {
    container.innerHTML = "<p>No videos uploaded yet.</p>";
    return;
  }

  container.innerHTML = videos.map((v) => {
    if (v.youtubeId) {
      return `
      <div class="video-item">
        <iframe width="320" height="180"
          src="https://www.youtube.com/embed/${v.youtubeId}"
          frameborder="0" allowfullscreen></iframe>
        <p>YouTube Video</p>
        <small>${new Date(v.date).toLocaleDateString()}</small><br>
        <button onclick="deleteItem('videos', '${v.id}')">Delete</button>
      </div>`;
    } else {
      return `
      <div class="video-item">
        <video controls width="320" height="180" poster="${v.posterUrl || "/assets/logo.png"}">
          <source src="${v.url}" type="video/mp4">
        </video>
        <p>${v.name || "Video"}</p>
        <small>${new Date(v.date).toLocaleDateString()}</small><br>
        <button onclick="deleteItem('videos', '${v.id}')">Delete</button>
      </div>`;
    }
  }).join("");

  // Track interactions
  document.querySelectorAll("#video-list video").forEach(v => {
    v.addEventListener("play", () => trackVideoInteraction("file"));
  });
  document.querySelectorAll("#video-list iframe").forEach(iframe => {
    const parent = iframe.closest(".video-item");
    if (parent && !parent.dataset.bound) {
      parent.dataset.bound = "1";
      parent.addEventListener("click", () => trackVideoInteraction("youtube"), { once: true });
    }
  });
}

function renderSponsors(sponsors = []) {
  const container = document.getElementById("sponsor-logos");
  if (!container) return;
  if (sponsors.length === 0) {
    container.innerHTML = "<p>No sponsors listed yet.</p>";
    return;
  }

  container.innerHTML = sponsors.map(
    (s) => `
    <div class="sponsor-item">
      <img src="${s.url}" alt="${s.name}" style="max-height:80px">
      <p>${s.name || ""}</p>
      <button onclick="deleteItem('sponsors', '${s.id}')">Delete</button>
    </div>`
  ).join("");
}

// ========== DELETE HANDLER ========== //
async function deleteItem(type, id) {
  if (!confirm("Are you sure you want to delete this item?")) return;
  try{
    const res = await fetch(`/delete/${type}/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.success) alert("Delete failed.");
    else loadSection(type);
  }catch(e){
    alert("Delete failed.");
  }
}

function initDropzones(){
  setupDrop("photo-drop", "photo-upload", "photos", "photo-progress");
  setupDrop("video-drop", "video-upload", "videos", "video-progress");
  setupDrop("sponsor-drop", "sponsor-upload", "sponsors", "sponsor-progress");
}
function setupDrop(dropId, inputId, type, progressId){
  const dz = document.getElementById(dropId);
  const input = document.getElementById(inputId);
  if(!dz || !input) return;
  dz.addEventListener("click", ()=> input.click());
  dz.addEventListener("dragover", (e)=>{ e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", ()=> dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e)=>{
    e.preventDefault(); dz.classList.remove("dragover");
    const files = Array.from(e.dataTransfer.files || []);
    if(files.length) uploadWithProgress(files, type, progressId);
  });
  input.addEventListener("change", (e)=>{
    const files = Array.from(e.target.files || []);
    if(files.length) uploadWithProgress(files, type, progressId);
  });
}

async function uploadWithProgress(files, type, progressId){
  const container = document.getElementById(progressId);
  if(container) container.innerHTML='';
  for(const file of files){
    // Create UI elements
    let wrap = document.createElement("div"); wrap.className="progress-wrapper";
    let bar = document.createElement("div"); bar.style.width="0%";
    let lbl = document.createElement("div"); lbl.className="progress-label"; lbl.textContent = `Uploading ${file.name}...`;
    wrap.appendChild(bar);
    if(container){ container.appendChild(lbl); container.appendChild(wrap); }

    try{
      // Presign
      const pres = await fetch(`/upload/presign/${type}`, {
        method: "POST", headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type })
      }).then(r=>r.json());
      if(!pres.success) throw new Error("Presign failed");

      // XHR PUT with progress
      await new Promise((resolve, reject)=>{
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", pres.uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.upload.onprogress = (e)=>{
          if(e.lengthComputable){
            const pct = Math.round((e.loaded/e.total)*100);
            bar.style.width = pct + "%";
          }
        };
        xhr.onerror = () => reject(new Error("XHR error"));
        xhr.onload = () => xhr.status>=200 && xhr.status<300 ? resolve() : reject(new Error("S3 upload failed"));
        xhr.send(file);
      });

      // Complete metadata
      const complete = await fetch("/upload/complete", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ type, key: pres.key, name: file.name, contentType: file.type })
      }).then(r=>r.json());
      
      bar.style.width = "100%";
      lbl.textContent = `Uploaded ${file.name}`;

      // Auto-generate video poster
      if(type === "videos" && file.type.startsWith("video/")){
        lbl.textContent = `Processing poster for ${file.name}...`;
        await fetch("/video/poster", {
          method: "POST", headers: { "Content-Type":"application/json" },
          body: JSON.stringify({ key: pres.key, id: complete.entry?.id })
        });
        lbl.textContent = `Uploaded ${file.name} (poster ready)`;
      }

    }catch(err){
      console.error(err);
      lbl.textContent = `Failed: ${file.name}`;
    }
  }
  loadSection(type);
}
