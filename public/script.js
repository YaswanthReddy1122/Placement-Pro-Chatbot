// ============================================================================
// GLOBAL STATE MANAGEMENT
// ============================================================================
let token = localStorage.getItem("token") || "";
let currentUser = null;
try {
  currentUser = JSON.parse(localStorage.getItem("user") || "null");
} catch(e) {
  currentUser = null;
}

let activeView = "dashboardView";
let chats = [];
let currentChatId = "";
let attachedFiles = [];
let codingChallenges = [];
let activeChallengeId = "";
let companyPrepData = {};
let aptitudeQuestions = {};
let activeQuizCategory = "";
let quizAnswers = {}; // id -> answer
let quizTimeRemaining = 300; // 5 minutes
let quizTimerInterval = null;
let currentQuizQuestionIndex = 0;
let isVoiceRecording = false;
let speechRecognitionObj = null;
let activeTheme = localStorage.getItem("themeMode") || "dark";

// ============================================================================
// APP INITS & TOAST / MODAL HELPER FUNCTIONS
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  initApp();
  
  // Collapse sidebar preference
  if (localStorage.getItem("sidebarCollapsed") === "true") {
    document.querySelector("#sidebar").classList.add("collapsed");
  }
});

function initApp() {
  lucide.createIcons();
  applyTheme();
  setupEventListeners();
  checkAuthStatus();
}

function applyTheme() {
  const body = document.body;
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  
  body.classList.remove("light-theme");
  
  if (activeTheme === "light") {
    body.classList.add("light-theme");
  } else if (activeTheme === "auto") {
    if (!darkQuery.matches) {
      body.classList.add("light-theme");
    }
  }
  
  const select = document.querySelector("#themeSelect");
  if (select) {
    select.value = activeTheme;
  }

  // Reset charts so they will rebuild with new theme colors
  if (typeof dashboardRadarInstance !== "undefined" && dashboardRadarInstance) {
    dashboardRadarInstance.destroy();
    dashboardRadarInstance = null;
  }
  if (typeof analyticsLineInstance !== "undefined" && analyticsLineInstance) {
    analyticsLineInstance.destroy();
    analyticsLineInstance = null;
  }
  if (typeof analyticsBarInstance !== "undefined" && analyticsBarInstance) {
    analyticsBarInstance.destroy();
    analyticsBarInstance = null;
  }
}

// Media Query listener for Auto mode
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (activeTheme === "auto") {
    applyTheme();
  }
});

function showToast(message, duration = 3000) {
  const toast = document.querySelector("#toastNotification");
  const msgEl = document.querySelector("#toastMessage");
  msgEl.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => {
    toast.classList.add("hidden");
  }, duration);
}

function openModal(modalId) {
  document.querySelector(`#${modalId}`).classList.remove("hidden");
}

function closeModal(modalId) {
  document.querySelector(`#${modalId}`).classList.add("hidden");
}

// ============================================================================
// AUTHENTICATION INTERCEPTORS & VISIBILITY CONTROLS
// ============================================================================
function checkAuthStatus() {
  if (token && currentUser) {
    document.querySelector("#authContainer").classList.add("hidden");
    document.querySelector("#appShell").classList.remove("hidden");
    
    // Update profile info
    updateProfileUI();
    
    // Load dashboard metrics
    switchView("dashboardView");
  } else {
    document.querySelector("#appShell").classList.add("hidden");
    document.querySelector("#authContainer").classList.remove("hidden");
    showAuthView("loginView");
  }
}

function showAuthView(viewId) {
  const views = ["loginView", "signupView", "forgotPasswordView", "resetPasswordView"];
  views.forEach(v => {
    document.querySelector(`#${v}`).classList.toggle("hidden", v !== viewId);
  });
}

function updateProfileUI() {
  if (!currentUser) return;
  document.querySelector("#sidebarUserName").textContent = currentUser.name;
  document.querySelector("#sidebarUserEmail").textContent = currentUser.email;
  
  const seed = currentUser.profile_photo || currentUser.name || "Alex";
  const avatarUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}`;
  
  document.querySelector("#sidebarUserPhoto").src = avatarUrl;
  document.querySelector("#profileUserPhoto").src = avatarUrl;
  
  // Pre-fill profile settings inputs
  document.querySelector("#profileName").value = currentUser.name;
  document.querySelector("#profileBranch").value = currentUser.branch || "";
  document.querySelector("#profileCgpa").value = currentUser.cgpa || "";
  document.querySelector("#profileSkills").value = currentUser.skills || "";
  document.querySelector("#avatarSeedInput").value = currentUser.profile_photo || "";
}

async function apiFetch(url, options = {}) {
  options.headers = options.headers || {};
  if (token) {
    options.headers["Authorization"] = `Bearer ${token}`;
  }
  
  // For file uploads, don't set Content-Type header manually
  if (!(options.body instanceof FormData)) {
    options.headers["Content-Type"] = options.headers["Content-Type"] || "application/json";
  }
  
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    if (response.status === 401) {
      // Token expired or invalid
      logout();
      showToast("Session expired. Please log in again.");
      return null;
    }
    if (!response.ok) {
      throw new Error(data.error || data.details || "API Request failed.");
    }
    return data;
  } catch (error) {
    showToast(error.message);
    throw error;
  }
}

// ============================================================================
// SIDEBAR COLLAPSE & SWITCH VIEW ROUTER
// ============================================================================
function setupEventListeners() {
  // Sidebar collapsing toggle
  document.querySelector("#sidebarToggle").addEventListener("click", () => {
    const sidebar = document.querySelector("#sidebar");
    sidebar.classList.toggle("collapsed");
    localStorage.setItem("sidebarCollapsed", sidebar.classList.contains("collapsed"));
  });

  // Sidebar navigation click mapping
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const viewId = item.getAttribute("data-view");
      if (viewId) switchView(viewId);
    });
  });

  // Logout button
  document.querySelector("#logoutBtn").addEventListener("click", logout);

  // Auth Routing buttons
  document.querySelector("#toSignupBtn").addEventListener("click", () => showAuthView("signupView"));
  document.querySelector("#toLoginBtn").addEventListener("click", () => showAuthView("loginView"));
  document.querySelector("#toForgotPasswordBtn").addEventListener("click", () => showAuthView("forgotPasswordView"));
  document.querySelector("#backToLoginFromForgotBtn").addEventListener("click", () => showAuthView("loginView"));

  // Forms Submits
  document.querySelector("#loginForm").addEventListener("submit", handleLoginSubmit);
  document.querySelector("#signupForm").addEventListener("submit", handleSignupSubmit);
  document.querySelector("#forgotPasswordForm").addEventListener("submit", handleForgotPasswordSubmit);
  document.querySelector("#resetPasswordForm").addEventListener("submit", handleResetPasswordSubmit);
  document.querySelector("#profileUpdateForm").addEventListener("submit", handleProfileUpdateSubmit);
  document.querySelector("#settingsForm").addEventListener("submit", handlePasswordChangeSubmit);

  // Chat composer event handlers
  document.querySelector("#chatForm").addEventListener("submit", handleChatSubmit);
  document.querySelector("#messageInput").addEventListener("input", autoExpandTextarea);
  document.querySelector("#messageInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.querySelector("#chatForm").requestSubmit();
    }
  });

  document.querySelector("#newChatBtn").addEventListener("click", () => startNewChat());
  document.querySelector("#clearChatBtn").addEventListener("click", () => clearConversation());

  // Attachments button trigger popup
  document.querySelector("#attachButton").addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelector("#attachmentMenu").classList.toggle("hidden");
  });

  document.addEventListener("click", () => {
    document.querySelector("#attachmentMenu").classList.add("hidden");
  });

  // Triggering native file upload picker clicks
  document.querySelectorAll(".menu-item-row").forEach(item => {
    item.addEventListener("click", () => {
      const type = item.getAttribute("data-type");
      const inputId = {
        image: "#fileInputImage",
        video: "#fileInputVideo",
        pdf: "#fileInputPDF",
        docx: "#fileInputDOCX",
        ppt: "#fileInputPPT",
        excel: "#fileInputExcel",
        file: "#fileInputFile"
      }[type];
      
      if (inputId) document.querySelector(inputId).click();
    });
  });

  // Native input change log file attachment previews
  [
    "#fileInputImage", "#fileInputVideo", "#fileInputPDF", 
    "#fileInputDOCX", "#fileInputPPT", "#fileInputExcel", "#fileInputFile"
  ].forEach(selector => {
    document.querySelector(selector).addEventListener("change", (e) => {
      appendFilesToPreview(e.target.files);
    });
  });

  // Drag & drop file handlers inside Chat module
  const chatMain = document.querySelector(".chat-main-area");
  chatMain.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.querySelector("#dragOverlay").classList.remove("hidden");
  });
  document.querySelector("#dragOverlay").addEventListener("dragleave", () => {
    document.querySelector("#dragOverlay").classList.add("hidden");
  });
  document.querySelector("#dragOverlay").addEventListener("drop", (e) => {
    e.preventDefault();
    document.querySelector("#dragOverlay").classList.add("hidden");
    appendFilesToPreview(e.dataTransfer.files);
  });

  // Speech processing (Voice Features)
  setupSpeechRecognition();

  // Resume generator forms & analyzer
  document.querySelector("#generatorForm").addEventListener("submit", handleResumeGenerateSubmit);
  document.querySelector("#resumeForm").addEventListener("submit", handleResumeAnalyzeSubmit);
  
  // Resume actions download triggers
  document.querySelector("#downloadPdfBtn").addEventListener("click", () => downloadGeneratedResume("pdf"));
  document.querySelector("#downloadDocxBtn").addEventListener("click", () => downloadGeneratedResume("docx"));
  document.querySelector("#printBtn").addEventListener("click", () => window.print());
  document.querySelector("#editBtn").addEventListener("click", toggleResumeTextEditor);

  // Resume dynamic item additions
  document.querySelectorAll("[data-section]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      addResumeSectionField(btn.getAttribute("data-section"));
    });
  });

  // Mock Interview round actions
  document.querySelector("#startInterviewButton").addEventListener("click", startMockInterview);
  document.querySelector("#finishInterviewButton").addEventListener("click", endMockInterview);
  document.querySelector("#interviewForm").addEventListener("submit", submitInterviewAnswer);
  document.querySelector("#interviewVoiceBtn").addEventListener("click", toggleInterviewSpeechRecognition);

  // Coding challenges language select starter code mapping
  document.querySelector("#editorLanguageSelect").addEventListener("change", () => {
    loadChallengeStarterTemplate();
  });
  document.querySelector("#submitCodeBtn").addEventListener("click", submitCodingSolution);

  // Company prep closing
  document.querySelector("#closeCompanyDetailsBtn").addEventListener("click", () => {
    document.querySelector("#companyDetailsOverlay").classList.add("hidden");
  });

  // Avatar generation seeds
  document.querySelector("#refreshAvatarBtn").addEventListener("click", () => {
    const seed = document.querySelector("#avatarSeedInput").value.trim() || Math.random().toString(36).substring(7);
    document.querySelector("#avatarSeedInput").value = seed;
    const avatarUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}`;
    document.querySelector("#profileUserPhoto").src = avatarUrl;
  });

  // Theme selection listener
  const themeSelect = document.querySelector("#themeSelect");
  if (themeSelect) {
    themeSelect.addEventListener("change", (e) => {
      activeTheme = e.target.value;
      localStorage.setItem("themeMode", activeTheme);
      applyTheme();
    });
  }

  // Session persistence checkbox listener
  const cookiePersistToggle = document.querySelector("#cookiePersistToggle");
  if (cookiePersistToggle) {
    // initialize from local storage if exists
    const cookiePersist = localStorage.getItem("cookiePersist");
    cookiePersistToggle.checked = cookiePersist !== "false"; // default to true
    cookiePersistToggle.addEventListener("change", (e) => {
      localStorage.setItem("cookiePersist", e.target.checked);
    });
  }

  // Check query reset url parsing
  if (window.location.hash.startsWith("#/reset-password") || window.location.search.includes("email=")) {
    const params = new URLSearchParams(window.location.search);
    const email = params.get("email");
    if (email) {
      showAuthView("resetPasswordView");
      // Add custom state field to forms reset password
      document.querySelector("#resetPasswordForm").dataset.email = email;
    }
  }
}

function switchView(viewId) {
  activeView = viewId;
  
  // Highlight active sidebar navigation option
  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.toggle("active", item.getAttribute("data-view") === viewId);
  });

  // Switch workspace content view visible classes
  document.querySelectorAll(".workspace-view").forEach(view => {
    view.classList.toggle("active-view", view.id === viewId);
  });

  // Trigger content-specific loaders
  if (viewId === "dashboardView") {
    loadDashboardMetrics();
  } else if (viewId === "chatView") {
    loadChatsHistory();
  } else if (viewId === "codingView") {
    loadCodingChallenges();
  } else if (viewId === "companyView") {
    loadCompanyPrepList();
  } else if (viewId === "analyticsView") {
    loadAnalyticsDashboard();
  } else if (viewId === "reportsView") {
    loadSavedReportsTable();
  }
  
  lucide.createIcons();
}

// ============================================================================
// AUTH SUBMISSIONS CONTROLLERS
// ============================================================================
async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.querySelector("#loginEmail").value.trim();
  const password = document.querySelector("#loginPassword").value.trim();
  
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Login Failed");
    }
    
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(currentUser));
    
    showToast("Logged in successfully!");
    checkAuthStatus();
  } catch(err) {
    showToast(err.message);
  }
}

async function handleSignupSubmit(e) {
  e.preventDefault();
  const name = document.querySelector("#signupName").value.trim();
  const email = document.querySelector("#signupEmail").value.trim();
  const password = document.querySelector("#signupPassword").value.trim();
  const branch = document.querySelector("#signupBranch").value.trim();
  const cgpa = document.querySelector("#signupCgpa").value.trim();
  const skills = document.querySelector("#signupSkills").value.trim();
  
  try {
    const response = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, branch, cgpa, skills })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Registration failed");
    }
    showToast(data.message);
    showAuthView("loginView");
  } catch(err) {
    showToast(err.message);
  }
}

async function handleForgotPasswordSubmit(e) {
  e.preventDefault();
  const email = document.querySelector("#forgotEmail").value.trim();
  try {
    const response = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await response.json();
    
    const container = document.querySelector("#resetLinkContainer");
    container.innerHTML = `
      <p>${data.message}</p>
      <a href="${data.reset_link}" style="color: var(--cyan); text-decoration: underline; margin-top: 4px; display: inline-block;">Reset Password Link (Mock Test)</a>
    `;
    container.classList.remove("hidden");
  } catch(err) {
    showToast(err.message);
  }
}

async function handleResetPasswordSubmit(e) {
  e.preventDefault();
  const password = document.querySelector("#resetPassword").value.trim();
  const email = e.target.dataset.email || "";
  
  try {
    const response = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    
    showToast(data.message);
    window.history.pushState({}, "", "/"); // Reset URL
    showAuthView("loginView");
  } catch(err) {
    showToast(err.message);
  }
}

async function handleProfileUpdateSubmit(e) {
  e.preventDefault();
  const name = document.querySelector("#profileName").value.trim();
  const branch = document.querySelector("#profileBranch").value.trim();
  const cgpa = document.querySelector("#profileCgpa").value.trim();
  const skills = document.querySelector("#profileSkills").value.trim();
  const profile_photo = document.querySelector("#avatarSeedInput").value.trim();
  
  try {
    const data = await apiFetch("/api/auth/profile", {
      method: "POST",
      body: JSON.stringify({ name, branch, cgpa, skills, profile_photo })
    });
    
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("token", token);
    localStorage.setItem("user", JSON.stringify(currentUser));
    
    updateProfileUI();
    showToast("Profile changes updated successfully!");
  } catch(err) {
    showToast(err.message);
  }
}

async function handlePasswordChangeSubmit(e) {
  e.preventDefault();
  const newPassword = document.querySelector("#settingsNewPassword").value.trim();
  if (!currentUser) return;
  try {
    const data = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ email: currentUser.email, password: newPassword })
    });
    showToast(data.message);
    document.querySelector("#settingsNewPassword").value = "";
  } catch(err) {
    showToast(err.message);
  }
}

function logout() {
  token = "";
  currentUser = null;
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  checkAuthStatus();
}

// ============================================================================
// DASHBOARD CONTROLLER
// ============================================================================
let dashboardRadarInstance = null;

async function loadDashboardMetrics() {
  if (!currentUser) return;
  
  document.querySelector("#dashboardGreeting").textContent = `Welcome back, ${currentUser.name}!`;
  
  try {
    const data = await apiFetch("/api/analytics", { method: "POST" });
    const metrics = data.metrics;
    
    // Update metric numbers
    document.querySelector("#dashboardResumeScore").textContent = metrics.resume_score || "--";
    document.querySelector("#dashboardResumeProgress").style.width = `${metrics.resume_score || 0}%`;
    
    document.querySelector("#dashboardReadinessScore").textContent = metrics.readiness_score || "--";
    document.querySelector("#dashboardReadinessProgress").style.width = `${metrics.readiness_score || 0}%`;
    
    document.querySelector("#dashboardInterviewScore").textContent = metrics.interview_score || "--";
    document.querySelector("#dashboardInterviewProgress").style.width = `${metrics.interview_score || 0}%`;
    
    const codingRatio = `${metrics.coding_solved} / ${metrics.coding_total}`;
    document.querySelector("#dashboardCodingScore").textContent = codingRatio;
    const codingPercent = (metrics.coding_solved / metrics.coding_total) * 100;
    document.querySelector("#dashboardCodingProgress").style.width = `${codingPercent}%`;
    
    const aptScore = metrics.aptitude_progress ? Math.round(metrics.aptitude_progress) : 0;
    document.querySelector("#dashboardAptitudeScore").textContent = aptScore > 0 ? `${aptScore}%` : "--%";
    document.querySelector("#dashboardAptitudeProgress").style.width = `${aptScore}%`;
    
    // Setup dashboard radar chart
    setupDashboardRadar(metrics);
    
    // Update AI banner
    generateAiRecommendation(metrics);
    
  } catch(err) {
    console.error("Dashboard metrics load error: ", err);
  }
}

function setupDashboardRadar(metrics) {
  const ctx = document.querySelector("#dashboardRadarChart");
  if (!ctx) return;
  
  const codingPercent = Math.round((metrics.coding_solved / metrics.coding_total) * 100) || 0;
  const dataValues = [
    metrics.resume_score || 0,
    metrics.readiness_score || 0,
    metrics.interview_score || 0,
    codingPercent,
    metrics.aptitude_progress || 0
  ];
  
  if (dashboardRadarInstance) {
    dashboardRadarInstance.data.datasets[0].data = dataValues;
    dashboardRadarInstance.update();
    return;
  }

  const isLight = document.body.classList.contains("light-theme");
  const gridColor = isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)';
  const tickColor = isLight ? '#475569' : '#64748B';
  const labelColor = isLight ? '#0F172A' : '#94A3B8';
  
  dashboardRadarInstance = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: ['Resume Audit', 'Readiness Score', 'Interview Practice', 'Coding Skills', 'Aptitude Accuracy'],
      datasets: [{
        label: 'Current Readiness Index',
        data: dataValues,
        backgroundColor: 'rgba(106, 92, 255, 0.2)',
        borderColor: '#6A5CFF',
        pointBackgroundColor: '#00D4FF',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          grid: { color: gridColor },
          angleLines: { color: gridColor },
          pointLabels: { color: labelColor, font: { family: 'Outfit', size: 10 } },
          ticks: { backdropColor: 'transparent', color: tickColor, min: 0, max: 100, stepSize: 20 }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

function generateAiRecommendation(metrics) {
  const bannerText = document.querySelector("#aiRecommendationText");
  
  if (!metrics.resume_score) {
    bannerText.textContent = "AI Tip: Begin by uploading your resume in the Resume Analyzer module for score diagnostics.";
    return;
  }
  if (metrics.resume_score < 75) {
    bannerText.textContent = "AI Tip: Your resume audit score is low. Update it inside Resume Generator to optimize ATS compatibility.";
    return;
  }
  if (metrics.coding_solved < 2) {
    bannerText.textContent = "AI Tip: Solve coding rounds algorithms (arrays/linked list tasks) to build dynamic technical credibility.";
    return;
  }
  if (!metrics.interview_score) {
    bannerText.textContent = "AI Tip: Start your mock interviews HR/Mixed practice loop today to record score dynamics.";
    return;
  }
  
  bannerText.textContent = "AI Tip: Preparation looks consistent! Practice mock quizzes and company interviews to unlock dream placements.";
}

// ============================================================================
// AI CHAT CONTROLLERS (ChatGPT experience with typewriter streaming)
// ============================================================================
async function loadChatsHistory() {
  try {
    const data = await apiFetch("/api/chats/manage", {
      method: "POST",
      body: JSON.stringify({ action: "list" })
    });
    
    chats = data.chats || [];
    renderChatSessions();
    
    // Auto-select latest chat session or start a new one
    if (chats.length > 0 && !currentChatId) {
      loadChatSession(chats[0].id);
    } else if (chats.length === 0) {
      startNewChat();
    }
  } catch(e) {
    console.error("Chats history error: ", e);
  }
}

function renderChatSessions() {
  const container = document.querySelector("#chatHistoryList");
  container.innerHTML = "";
  
  chats.forEach(chat => {
    const item = document.createElement("button");
    item.className = `chat-history-item ${chat.id === currentChatId ? 'active' : ''}`;
    item.setAttribute("type", "button");
    item.onclick = () => loadChatSession(chat.id);
    
    item.innerHTML = `
      <i data-lucide="message-square" class="size-xs"></i>
      <span class="chat-item-text">${escapeHtml(chat.title)}</span>
      <div class="chat-item-actions">
        <button type="button" class="chat-item-action-btn" onclick="event.stopPropagation(); triggerRenameChat('${chat.id}')"><i data-lucide="edit-3" class="size-xs"></i></button>
        <button type="button" class="chat-item-action-btn" onclick="event.stopPropagation(); deleteChatSession('${chat.id}')"><i data-lucide="trash-2" class="size-xs"></i></button>
      </div>
    `;
    container.appendChild(item);
  });
  
  lucide.createIcons();
}

function startNewChat() {
  currentChatId = "chat_" + Math.random().toString(36).substring(7);
  document.querySelector("#currentChatTitle").textContent = "New Conversation";
  
  // Clear log
  const chatLog = document.querySelector("#chatLog");
  chatLog.innerHTML = "";
  
  // Render welcome bubbles
  appendChatBubble("assistant", "Hi, I am AI Placement Assistant Pro. I can analyze resumes, practice mock interview answers, construct career roadmaps, or evaluate coding round algorithms. Ask me anything to begin!");
  
  // Select active state in sidebar
  document.querySelectorAll(".chat-history-item").forEach(el => el.classList.remove("active"));
}

function loadChatSession(id) {
  currentChatId = id;
  const chat = chats.find(c => c.id === id);
  if (!chat) return;
  
  document.querySelector("#currentChatTitle").textContent = chat.title;
  
  const chatLog = document.querySelector("#chatLog");
  chatLog.innerHTML = "";
  
  chat.history.forEach(msg => {
    appendChatBubble(msg.role, msg.content);
  });
  
  renderChatSessions();
}

function appendChatBubble(role, content) {
  const chatLog = document.querySelector("#chatLog");
  const row = document.createElement("div");
  row.className = `chat-message-row ${role === 'user' ? 'user' : 'assistant'}`;
  
  const icon = role === 'user' ? 'user' : 'bottts';
  const nameInit = role === 'user' ? (currentUser?.name ? currentUser.name[0] : 'U') : 'AI';
  
  row.innerHTML = `
    <div class="chat-avatar">${nameInit}</div>
    <div class="chat-message-body">
      <div class="chat-bubble">${formatMarkdownText(content)}</div>
      <div class="chat-message-actions">
        <button type="button" class="chat-action-btn" onclick="copyMessageText(this)"><i data-lucide="copy"></i> Copy</button>
        ${role === 'assistant' ? `<button type="button" class="chat-action-btn" onclick="voiceOutText(this)"><i data-lucide="volume-2"></i> Voice</button>` : ''}
      </div>
    </div>
  `;
  
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  lucide.createIcons();
  return row;
}

// Copy Action
function copyMessageText(btn) {
  const bubble = btn.closest(".chat-message-body").querySelector(".chat-bubble");
  navigator.clipboard.writeText(bubble.textContent).then(() => {
    showToast("Copied to clipboard!");
  });
}

// TTS Audio
function voiceOutText(btn) {
  const bubble = btn.closest(".chat-message-body").querySelector(".chat-bubble");
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(bubble.textContent);
  window.speechSynthesis.speak(utterance);
}

// Simulated Typewriter Word-by-Word output
function streamAssistantResponse(fullReply) {
  const chatLog = document.querySelector("#chatLog");
  const row = document.createElement("div");
  row.className = "chat-message-row assistant";
  
  row.innerHTML = `
    <div class="chat-avatar">AI</div>
    <div class="chat-message-body">
      <div class="chat-bubble"></div>
      <div class="chat-message-actions">
        <button type="button" class="chat-action-btn" onclick="copyMessageText(this)"><i data-lucide="copy"></i> Copy</button>
        <button type="button" class="chat-action-btn" onclick="voiceOutText(this)"><i data-lucide="volume-2"></i> Voice</button>
      </div>
    </div>
  `;
  
  chatLog.appendChild(row);
  lucide.createIcons();
  
  const bubble = row.querySelector(".chat-bubble");
  const words = fullReply.split(" ");
  let wordIdx = 0;
  
  const interval = setInterval(() => {
    if (wordIdx < words.length) {
      bubble.innerHTML = formatMarkdownText(words.slice(0, wordIdx + 1).join(" "));
      chatLog.scrollTop = chatLog.scrollHeight;
      wordIdx++;
    } else {
      clearInterval(interval);
      // Save full chat history back to DB
      saveCurrentChatSession();
    }
  }, 45); // Typist velocity
}

async function handleChatSubmit(e) {
  e.preventDefault();
  const input = document.querySelector("#messageInput");
  const message = input.value.trim();
  if (!message) return;
  
  // Clear input
  input.value = "";
  autoExpandTextarea();
  
  // Render user bubble
  appendChatBubble("user", message);
  
  // Append temporary typing indicator
  const chatLog = document.querySelector("#chatLog");
  const typingRow = document.createElement("div");
  typingRow.className = "chat-message-row assistant";
  typingRow.id = "chatTypingRow";
  typingRow.innerHTML = `
    <div class="chat-avatar">AI</div>
    <div class="chat-message-body">
      <div class="chat-bubble typing-bubble">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;
  chatLog.appendChild(typingRow);
  chatLog.scrollTop = chatLog.scrollHeight;
  
  try {
    const activeHistory = getActiveChatHistory();
    // Prepend attached file descriptors to message context if present
    let finalMsg = message;
    if (attachedFiles.length > 0) {
      finalMsg = `[Context Uploaded Files: ${attachedFiles.map(f => f.name).join(", ")}]\n\n${message}`;
      attachedFiles = [];
      document.querySelector("#attachmentPanel").classList.add("hidden");
      document.querySelector("#attachmentPreviewList").innerHTML = "";
    }
    
    const data = await apiFetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message: finalMsg,
        history: activeHistory
      })
    });
    
    // Remove typing indicator
    document.querySelector("#chatTypingRow")?.remove();
    
    // Render typewriter stream assistant bubble
    streamAssistantResponse(data.reply);
  } catch(err) {
    document.querySelector("#chatTypingRow")?.remove();
    appendChatBubble("assistant", "Sorry, I encountered an error calling the model. Please check connection.");
  }
}

function getActiveChatHistory() {
  const activeHistory = [];
  const log = document.querySelector("#chatLog");
  const bubbles = log.querySelectorAll(".chat-message-row");
  bubbles.forEach(b => {
    const isUser = b.classList.contains("user");
    const text = b.querySelector(".chat-bubble").textContent;
    activeHistory.push({
      role: isUser ? "user" : "assistant",
      content: text
    });
  });
  return activeHistory;
}

async function saveCurrentChatSession() {
  const currentHistory = getActiveChatHistory();
  if (currentHistory.length === 0) return;
  
  // Determine title from first query if title was default
  let title = document.querySelector("#currentChatTitle").textContent;
  if (title === "New Conversation" && currentHistory[0]) {
    title = currentHistory[0].content.slice(0, 24) + "...";
    document.querySelector("#currentChatTitle").textContent = title;
  }
  
  try {
    await apiFetch("/api/chats/manage", {
      method: "POST",
      body: JSON.stringify({
        action: "save",
        id: currentChatId,
        title: title,
        history: currentHistory
      })
    });
    
    // Reload history pane
    const listData = await apiFetch("/api/chats/manage", {
      method: "POST",
      body: JSON.stringify({ action: "list" })
    });
    chats = listData.chats || [];
    renderChatSessions();
  } catch(e) {
    console.error("Chat saving error: ", e);
  }
}

let chatRenameTargetId = "";
function triggerRenameChat(id) {
  chatRenameTargetId = id;
  const chat = chats.find(c => c.id === id);
  document.querySelector("#newChatNameInput").value = chat ? chat.title : "";
  openModal("renameChatModal");
}

document.querySelector("#submitRenameChatBtn").addEventListener("click", async () => {
  const title = document.querySelector("#newChatNameInput").value.trim();
  if (!title || !chatRenameTargetId) return;
  
  try {
    await apiFetch("/api/chats/manage", {
      method: "POST",
      body: JSON.stringify({ action: "rename", id: chatRenameTargetId, title })
    });
    closeModal("renameChatModal");
    showToast("Chat renamed!");
    
    // Update active view headers if current active chat renamed
    if (chatRenameTargetId === currentChatId) {
      document.querySelector("#currentChatTitle").textContent = title;
    }
    loadChatsHistory();
  } catch(e) {
    showToast("Error renaming chat");
  }
});

async function deleteChatSession(id) {
  if (!confirm("Are you sure you want to delete this chat?")) return;
  try {
    await apiFetch("/api/chats/manage", {
      method: "POST",
      body: JSON.stringify({ action: "delete", id })
    });
    showToast("Chat deleted.");
    if (currentChatId === id) {
      currentChatId = "";
    }
    loadChatsHistory();
  } catch(e) {
    showToast("Error deleting chat");
  }
}

function clearConversation() {
  if (confirm("Reset conversation logs?")) {
    startNewChat();
  }
}

// ============================================================================
// COMPOSER FILE ATTACHMENTS SYSTEM
// ============================================================================
function appendFilesToPreview(filesList) {
  if (filesList.length === 0) return;
  
  document.querySelector("#attachmentPanel").classList.remove("hidden");
  const container = document.querySelector("#attachmentPreviewList");
  
  Array.from(filesList).forEach(file => {
    // Generate mock visual preview details
    const fileId = "file_" + Math.random().toString(36).substring(7);
    const mockFileObj = { id: fileId, name: file.name, size: file.size, type: file.type };
    attachedFiles.push(mockFileObj);
    
    const card = document.createElement("div");
    card.className = "attachment-preview-card";
    card.id = fileId;
    
    card.innerHTML = `
      <i data-lucide="file" class="size-xs text-cyan"></i>
      <span>${escapeHtml(file.name)}</span>
      <button type="button" class="attachment-remove-btn" onclick="removeAttachedFile('${fileId}')">×</button>
    `;
    container.appendChild(card);
  });
  lucide.createIcons();
}

function removeAttachedFile(id) {
  attachedFiles = attachedFiles.filter(f => f.id !== id);
  document.querySelector(`#${id}`)?.remove();
  if (attachedFiles.length === 0) {
    document.querySelector("#attachmentPanel").classList.add("hidden");
  }
}

// ============================================================================
// RESUME BUILDER & AUDITOR MODULES
// ============================================================================
let resumeProjectCount = 0;
let resumeExperienceCount = 0;
let resumeCertificationCount = 0;
let generatedResumeHtml = "";

function addResumeSectionField(section) {
  const container = {
    projects: document.querySelector("#projectsContainer"),
    experience: document.querySelector("#experienceContainer"),
    certifications: document.querySelector("#certificationsContainer")
  }[section];
  
  if (!container) return;
  
  const index = container.children.length;
  const el = document.createElement("div");
  el.className = "item-group mt-sm";
  
  if (section === "projects") {
    el.innerHTML = `
      <button type="button" class="remove-item-btn" onclick="this.parentElement.remove()">×</button>
      <input type="text" placeholder="Project Name" data-field="projectName${index}" required>
      <input type="text" placeholder="Tech Used (React, SQL...)" data-field="projectTech${index}">
      <textarea placeholder="Bullet descriptions (AI will enhance these)" data-field="projectDesc${index}" rows="2" required></textarea>
    `;
  } else if (section === "experience") {
    el.innerHTML = `
      <button type="button" class="remove-item-btn" onclick="this.parentElement.remove()">×</button>
      <input type="text" placeholder="Company Name" data-field="expCompany${index}" required>
      <input type="text" placeholder="Role (e.g. Intern)" data-field="expRole${index}" required>
      <input type="text" placeholder="Duration (e.g. June 2025 - August 2025)" data-field="expDuration${index}">
      <textarea placeholder="Job responsibilities..." data-field="expDesc${index}" rows="2" required></textarea>
    `;
  } else if (section === "certifications") {
    el.innerHTML = `
      <button type="button" class="remove-item-btn" onclick="this.parentElement.remove()">×</button>
      <input type="text" placeholder="Certificate Name" data-field="certName${index}" required>
      <input type="text" placeholder="Issuing Organization" data-field="certIssuer${index}">
      <input type="text" placeholder="Year" data-field="certYear${index}">
    `;
  }
  
  container.appendChild(el);
}

async function handleResumeGenerateSubmit(e) {
  e.preventDefault();
  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData.entries());
  
  // Package dynamic array fields
  data.projects = getPackagedDynamicSection("projectsContainer", ["projectName", "projectTech", "projectDesc"]);
  data.experience = getPackagedDynamicSection("experienceContainer", ["expCompany", "expRole", "expDuration", "expDesc"]);
  data.certifications = getPackagedDynamicSection("certificationsContainer", ["certName", "certIssuer", "certYear"]);
  
  document.querySelector("#generatorStatus").classList.remove("hidden");
  
  try {
    const res = await apiFetch("/api/generate-resume", {
      method: "POST",
      body: JSON.stringify(data)
    });
    
    generatedResumeHtml = res.html;
    
    // Hide overlay & show preview content
    document.querySelector("#generatorStatus").classList.add("hidden");
    document.querySelector("#resumePreview").querySelector(".empty-preview-state")?.classList.add("hidden");
    
    const previewContent = document.querySelector("#previewContent");
    previewContent.innerHTML = generatedResumeHtml;
    previewContent.classList.remove("hidden");
    
    showToast("Resume optimized and formatted!");
  } catch(err) {
    document.querySelector("#generatorStatus").classList.add("hidden");
    showToast("Failed to generate resume draft.");
  }
}

function getPackagedDynamicSection(containerId, fields) {
  const container = document.querySelector(`#${containerId}`);
  const items = [];
  
  Array.from(container.children).forEach((child, index) => {
    const obj = {};
    fields.forEach(field => {
      // Find matching index inside dataset inputs
      const input = child.querySelector(`[data-field^="${field}"]`);
      if (input) {
        // Strip prefix index to return standardized clean keys
        const cleanKey = field.replace(/^[a-z]+(?=[A-Z])/, '').toLowerCase();
        obj[field] = input.value;
      }
    });
    items.push(obj);
  });
  return items;
}

async function downloadGeneratedResume(format) {
  if (!generatedResumeHtml) {
    showToast("Please generate a resume draft first.");
    return;
  }
  try {
    const data = await apiFetch("/api/export-resume", {
      method: "POST",
      body: JSON.stringify({
        html: generatedResumeHtml,
        format: format,
        filename: `Placement_Resume.${format}`
      })
    });
    
    // Download base64 blob bytes
    const blob = base64ToBlob(data.data, format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = data.filename;
    link.click();
    showToast("Download started!");
  } catch(e) {
    showToast("Export failed.");
  }
}

function toggleResumeTextEditor() {
  const preview = document.querySelector("#previewContent");
  if (preview.getAttribute("contenteditable") === "true") {
    preview.setAttribute("contenteditable", "false");
    generatedResumeHtml = preview.innerHTML;
    showToast("Edits saved to preview buffer.");
  } else {
    preview.setAttribute("contenteditable", "true");
    preview.focus();
    showToast("Direct inline text editing enabled.");
  }
}

// Resume Analyzer submit
async function handleResumeAnalyzeSubmit(e) {
  e.preventDefault();
  const fileInput = document.querySelector("#resumeFile");
  if (fileInput.files.length === 0) return;
  
  const formPayload = new FormData();
  formPayload.append("resume", fileInput.files[0]);
  
  document.querySelector("#analyzeResumeButton").disabled = true;
  document.querySelector("#analyzeResumeButton").textContent = "Auditing File...";
  
  try {
    const data = await apiFetch("/api/resume-analyze", {
      method: "POST",
      body: formPayload
    });
    
    document.querySelector("#analyzeResumeButton").disabled = false;
    document.querySelector("#analyzeResumeButton").textContent = "Audit Resume";
    
    // Parse response parameters and render circular scores
    const replyText = data.reply;
    const resScore = findScoreInText(replyText, ["Resume Score", "Overall Resume Score"]) || 75;
    const atsScore = findScoreInText(replyText, ["ATS Compatibility", "ATS Score", "ATS Compatibility Score"]) || 70;
    
    document.querySelector("#resumeScoreVal").textContent = resScore;
    document.querySelector("#resumeAtsVal").textContent = atsScore;
    
    document.querySelector("#resumeReportText").innerHTML = formatMarkdownText(replyText);
    document.querySelector("#resumeResults").classList.remove("hidden");
    
    // Hook up download report button
    document.querySelector("#downloadResumeReportBtn").onclick = () => {
      const blob = new Blob([replyText], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "Resume_Audit_Report.txt";
      a.click();
    };
    
    showToast("Resume Audit Complete!");
  } catch(err) {
    document.querySelector("#analyzeResumeButton").disabled = false;
    document.querySelector("#analyzeResumeButton").textContent = "Audit Resume";
    showToast("Resume audit failed.");
  }
}

// ============================================================================
// MOCK INTERVIEW MODULE (TTS and STT integrations)
// ============================================================================
let mockInterviewLogs = [];

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn("Speech recognition is not supported in this browser. Voice input will not function.");
    return;
  }
  
  speechRecognitionObj = new SpeechRecognition();
  speechRecognitionObj.continuous = true;
  speechRecognitionObj.interimResults = false;
  speechRecognitionObj.lang = 'en-US';
  
  speechRecognitionObj.onresult = (event) => {
    const result = event.results[event.results.length - 1][0].transcript;
    
    if (activeView === "chatView") {
      document.querySelector("#messageInput").value += result;
      autoExpandTextarea();
    } else if (activeView === "interviewView") {
      document.querySelector("#interviewAnswer").value += result;
    }
  };
  
  speechRecognitionObj.onerror = (e) => {
    console.error("Speech Recognition error: ", e);
    stopRecordingVoice();
  };
  
  speechRecognitionObj.onend = () => {
    isVoiceRecording = false;
    updateVoiceIconUI(false);
  };
}

function startRecordingVoice() {
  if (!speechRecognitionObj) return;
  try {
    speechRecognitionObj.start();
    isVoiceRecording = true;
    updateVoiceIconUI(true);
  } catch(e) {
    console.error(e);
  }
}

function stopRecordingVoice() {
  if (!speechRecognitionObj) return;
  try {
    speechRecognitionObj.stop();
    isVoiceRecording = false;
    updateVoiceIconUI(false);
  } catch(e) {
    console.error(e);
  }
}

function updateVoiceIconUI(recording) {
  const micIcon = document.querySelector("#voiceMicIcon");
  const interviewMic = document.querySelector("#interviewMicIcon");
  const interviewBtn = document.querySelector("#interviewVoiceBtn");
  
  if (recording) {
    micIcon?.classList.add("text-red");
    interviewMic?.classList.add("text-white");
    interviewBtn?.classList.add("recording");
  } else {
    micIcon?.classList.remove("text-red");
    interviewMic?.classList.remove("text-white");
    interviewBtn?.classList.remove("recording");
  }
}

// Chat speech trigger
document.querySelector("#voiceInputBtn").addEventListener("click", () => {
  if (isVoiceRecording) {
    stopRecordingVoice();
  } else {
    startRecordingVoice();
  }
});

// Mock interview speech trigger
function toggleInterviewSpeechRecognition() {
  if (isVoiceRecording) {
    stopRecordingVoice();
  } else {
    startRecordingVoice();
  }
}

async function startMockInterview() {
  const mode = document.querySelector("#interviewMode").value;
  mockInterviewLogs = [];
  
  const logContainer = document.querySelector("#interviewLog");
  logContainer.innerHTML = "";
  
  // Set loadings
  document.querySelector("#startInterviewButton").disabled = true;
  document.querySelector("#startInterviewButton").textContent = "Setting context...";
  
  try {
    const data = await apiFetch("/api/interview", {
      method: "POST",
      body: JSON.stringify({
        mode: mode,
        stage: "start",
        history: []
      })
    });
    
    document.querySelector("#startInterviewButton").disabled = false;
    document.querySelector("#startInterviewButton").textContent = "Start Interview";
    document.querySelector("#finishInterviewButton").disabled = false;
    
    // Render question
    const qRow = appendInterviewBubble("Interviewer", data.reply);
    mockInterviewLogs.push({ role: "assistant", content: data.reply });
    
    // Voice prompt check
    if (document.querySelector("#ttsToggle").checked) {
      triggerTTSVoice(data.reply);
    }
    
    // Reveal composer form
    document.querySelector("#interviewForm").classList.remove("hidden");
    document.querySelector("#interviewAnswer").disabled = false;
    document.querySelector("#interviewAnswer").focus();
  } catch(err) {
    document.querySelector("#startInterviewButton").disabled = false;
    document.querySelector("#startInterviewButton").textContent = "Start Interview";
    showToast("Failed to initialize interviewer parameters.");
  }
}

function appendInterviewBubble(speaker, content) {
  const log = document.querySelector("#interviewLog");
  log.querySelector(".empty-preview-state")?.remove();
  
  const card = document.createElement("div");
  card.className = `interview-bubble ${speaker === 'Interviewer' ? 'interviewer' : 'candidate'}`;
  card.innerHTML = `
    <span class="bubble-speaker">${speaker}</span>
    <p>${formatMarkdownText(content)}</p>
  `;
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
  return card;
}

function triggerTTSVoice(text) {
  window.speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(text);
  speech.rate = 0.95;
  window.speechSynthesis.speak(speech);
}

async function submitInterviewAnswer(e) {
  e.preventDefault();
  const ansField = document.querySelector("#interviewAnswer");
  const answer = ansField.value.trim();
  if (!answer) return;
  
  // Stop recording if speaking
  if (isVoiceRecording) stopRecordingVoice();
  
  ansField.value = "";
  appendInterviewBubble("You", answer);
  mockInterviewLogs.push({ role: "user", content: answer });
  
  document.querySelector("#sendInterviewButton").disabled = true;
  
  try {
    const data = await apiFetch("/api/interview", {
      method: "POST",
      body: JSON.stringify({
        mode: document.querySelector("#interviewMode").value,
        stage: "answer",
        answer: answer,
        history: mockInterviewLogs.slice(0, -1) // Excluding latest user answer from Llama's history format
      })
    });
    
    document.querySelector("#sendInterviewButton").disabled = false;
    appendInterviewBubble("Interviewer", data.reply);
    mockInterviewLogs.push({ role: "assistant", content: data.reply });
    
    if (document.querySelector("#ttsToggle").checked) {
      triggerTTSVoice(data.reply);
    }
    ansField.focus();
  } catch(err) {
    document.querySelector("#sendInterviewButton").disabled = false;
    showToast("Interviewer connection dropped.");
  }
}

async function endMockInterview() {
  document.querySelector("#finishInterviewButton").disabled = true;
  document.querySelector("#finishInterviewButton").textContent = "Grading...";
  
  try {
    const data = await apiFetch("/api/interview", {
      method: "POST",
      body: JSON.stringify({
        mode: document.querySelector("#interviewMode").value,
        stage: "finish",
        history: mockInterviewLogs
      })
    });
    
    document.querySelector("#finishInterviewButton").disabled = false;
    document.querySelector("#finishInterviewButton").textContent = "Finish & Grade";
    
    document.querySelector("#interviewForm").classList.add("hidden");
    
    // Renders audit logs
    appendInterviewBubble("Interviewer Report Card", data.reply);
    showToast("Mock session completed and report generated!");
  } catch(e) {
    document.querySelector("#finishInterviewButton").disabled = false;
    document.querySelector("#finishInterviewButton").textContent = "Finish & Grade";
    showToast("Error generating mock grade scorecard.");
  }
}

// ============================================================================
// PROFILE READINESS
// ============================================================================
document.querySelector("#readinessForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(e.target).entries());
  
  document.querySelector("#readinessButton").disabled = true;
  document.querySelector("#readinessButton").textContent = "Computing Readiness Index...";
  
  try {
    const data = await apiFetch("/api/readiness", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    
    document.querySelector("#readinessButton").disabled = false;
    document.querySelector("#readinessButton").textContent = "Check Placement Readiness";
    
    // Parse scores
    const replyText = data.reply;
    const rScore = findScoreInText(replyText, ["Placement Readiness Score", "Readiness Score"]) || 80;
    
    document.querySelector("#readinessScoreVal").textContent = rScore;
    document.querySelector("#readinessScoreFill").style.width = `${rScore}%`;
    
    let prob = "High";
    if (rScore < 50) prob = "Low";
    else if (rScore < 75) prob = "Medium";
    
    const probEl = document.querySelector("#readinessProbabilityVal");
    probEl.textContent = prob;
    probEl.className = prob === "High" ? "text-green" : prob === "Medium" ? "text-cyan" : "text-red";
    
    // Extract target companies listing
    document.querySelector("#dreamCompaniesList").innerHTML = extractSections(replyText, "Dream Companies");
    document.querySelector("#moderateCompaniesList").innerHTML = extractSections(replyText, "Moderate Companies");
    document.querySelector("#safeCompaniesList").innerHTML = extractSections(replyText, "Safe Companies");
    
    // Render dynamic visual roadmap timeline
    const roadmapEl = document.querySelector("#readinessRoadmapList");
    roadmapEl.innerHTML = "";
    
    const steps = extractRoadmapSteps(replyText);
    steps.forEach((step, index) => {
      const stepCard = document.createElement("div");
      stepCard.className = "roadmap-step-item";
      stepCard.innerHTML = `
        <span>${index + 1}</span>
        <p>${escapeHtml(step)}</p>
      `;
      roadmapEl.appendChild(stepCard);
    });
    
    document.querySelector("#readinessResults").classList.remove("hidden");
    showToast("Placement metrics generated!");
  } catch(err) {
    document.querySelector("#readinessButton").disabled = false;
    document.querySelector("#readinessButton").textContent = "Check Placement Readiness";
    showToast("Readiness diagnostics check failed.");
  }
});

function extractSections(text, label) {
  const match = text.match(new RegExp(`${label}[^:]*:(.*?)(\\n\\n|$)`, "i"));
  return match ? formatMarkdownText(match[1].trim()) : "Profile-specific Tier";
}

function extractRoadmapSteps(text) {
  const lines = text.split("\n");
  const steps = [];
  let recording = false;
  
  for (let line of lines) {
    if (line.toLowerCase().includes("improvement roadmap") || line.toLowerCase().includes("roadmap")) {
      recording = true;
      continue;
    }
    if (recording) {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("-") || /^\d+\./.test(trimmed)) {
        steps.push(trimmed.replace(/^[*-\d.]\s*/, ''));
      }
      if (steps.length >= 5 || (trimmed === "" && steps.length > 0)) {
        break;
      }
    }
  }
  
  if (steps.length === 0) {
    steps.push("Optimize structural project architecture statements", "Implement LeetCode exercises", "Improve average mock interview performance");
  }
  return steps;
}

// ============================================================================
// CODING PRACTICE SANDBOX
// ============================================================================
async function loadCodingChallenges() {
  try {
    const data = await apiFetch("/api/coding/challenges", { method: "POST" });
    codingChallenges = data.challenges || [];
    renderCodingChallengesSidebar();
  } catch(e) {
    console.error("Challenges load error: ", e);
  }
}

function renderCodingChallengesSidebar() {
  const list = document.querySelector("#codingChallengesList");
  list.innerHTML = "";
  
  codingChallenges.forEach(c => {
    const card = document.createElement("div");
    card.className = `challenge-index-card ${c.id === activeChallengeId ? 'active' : ''}`;
    card.onclick = () => selectCodingChallenge(c.id);
    
    let diffClass = "badge-green";
    if (c.difficulty === "Medium") diffClass = "badge-cyan";
    else if (c.difficulty === "Hard") diffClass = "badge-purple";
    
    card.innerHTML = `
      <h5>${escapeHtml(c.title)}</h5>
      <div class="challenge-card-footer">
        <span class="text-xs text-muted">${escapeHtml(c.category)}</span>
        <span class="badge ${diffClass}">${escapeHtml(c.difficulty)}</span>
      </div>
    `;
    list.appendChild(card);
  });
}

function selectCodingChallenge(id) {
  activeChallengeId = id;
  const challenge = codingChallenges.find(c => c.id === id);
  if (!challenge) return;
  
  document.querySelector("#codingEditorEmptyState").classList.add("hidden");
  document.querySelector("#codingWorkspaceArea").classList.remove("hidden");
  
  document.querySelector("#currentCodingTitle").textContent = challenge.title;
  document.querySelector("#currentCodingDesc").textContent = challenge.description;
  
  const diffBadge = document.querySelector("#currentCodingDifficulty");
  diffBadge.textContent = challenge.difficulty;
  diffBadge.className = `badge ${challenge.difficulty === 'Easy' ? 'badge-green' : challenge.difficulty === 'Medium' ? 'badge-cyan' : 'badge-purple'}`;
  
  // Reset coder text area
  loadChallengeStarterTemplate();
  
  // Hide feedback card
  document.querySelector("#codingFeedbackCard").classList.add("hidden");
  
  renderCodingChallengesSidebar();
}

function loadChallengeStarterTemplate() {
  if (!activeChallengeId) return;
  const challenge = codingChallenges.find(c => c.id === activeChallengeId);
  const lang = document.querySelector("#editorLanguageSelect").value;
  const starter = challenge.starter_code[lang] || "";
  document.querySelector("#codeEditorTextarea").value = starter;
}

async function submitCodingSolution() {
  const code = document.querySelector("#codeEditorTextarea").value.trim();
  const lang = document.querySelector("#editorLanguageSelect").value;
  
  if (!code || !activeChallengeId) return;
  
  document.querySelector("#submitCodeBtn").disabled = true;
  document.querySelector("#submitCodeBtn").innerHTML = "<div class='spinner-loader' style='width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;'></div> Evaluating Solution...";
  
  try {
    const data = await apiFetch("/api/coding/submit", {
      method: "POST",
      body: JSON.stringify({
        challenge_id: activeChallengeId,
        code: code,
        language: lang
      })
    });
    
    document.querySelector("#submitCodeBtn").disabled = false;
    document.querySelector("#submitCodeBtn").innerHTML = "<i data-lucide='play'></i> Submit & Analyze with AI";
    lucide.createIcons();
    
    document.querySelector("#codingFeedbackText").innerHTML = formatMarkdownText(data.feedback);
    document.querySelector("#codingFeedbackCard").classList.remove("hidden");
    showToast("Evaluation generated successfully!");
  } catch(e) {
    document.querySelector("#submitCodeBtn").disabled = false;
    document.querySelector("#submitCodeBtn").innerHTML = "<i data-lucide='play'></i> Submit & Analyze with AI";
    lucide.createIcons();
    showToast("Audit feedback failed.");
  }
}

// ============================================================================
// TIMED APTITUDE QUIZZES
// ============================================================================
async function startAptitudeQuiz(category) {
  activeQuizCategory = category;
  quizAnswers = {};
  currentQuizQuestionIndex = 0;
  
  // Toggle Visibility
  document.querySelector("#aptitudeCategorySelector").classList.add("hidden");
  document.querySelector("#aptitudeQuizArena").classList.remove("hidden");
  
  // Fetch questions
  try {
    const data = await apiFetch("/api/aptitude/questions", { method: "POST" });
    aptitudeQuestions[category] = data.questions[category] || [];
    
    // Reset timers variables
    quizTimeRemaining = 300; // 5 mins
    updateTimerUI();
    clearInterval(quizTimerInterval);
    
    quizTimerInterval = setInterval(() => {
      quizTimeRemaining--;
      updateTimerUI();
      if (quizTimeRemaining <= 0) {
        clearInterval(quizTimerInterval);
        submitAptitudeQuiz();
      }
    }, 1000);
    
    renderQuizQuestion();
  } catch(err) {
    showToast("Failed to pull quiz questions.");
    exitQuizArena();
  }
}

function updateTimerUI() {
  const min = Math.floor(quizTimeRemaining / 60);
  const sec = quizTimeRemaining % 60;
  const timeStr = `${min}:${sec < 10 ? '0' + sec : sec}`;
  const display = document.querySelector("#quizTimerVal");
  display.innerHTML = `<i data-lucide="clock" class="size-xs mr-xs"></i> ${timeStr}`;
  lucide.createIcons();
}

function renderQuizQuestion() {
  const questions = aptitudeQuestions[activeQuizCategory];
  if (!questions || questions.length === 0) return;
  
  const q = questions[currentQuizQuestionIndex];
  
  document.querySelector("#currentQuizCategoryTitle").textContent = `${activeQuizCategory.toUpperCase()} Tests - Question ${currentQuizQuestionIndex + 1} of ${questions.length}`;
  document.querySelector("#quizQuestionText").textContent = q.question;
  
  // Progress tracker fill
  const percent = ((currentQuizQuestionIndex + 1) / questions.length) * 100;
  document.querySelector("#quizProgressFill").style.width = `${percent}%`;
  
  // Render options list
  const list = document.querySelector("#quizOptionsContainer");
  list.innerHTML = "";
  
  q.options.forEach(opt => {
    const optCard = document.createElement("label");
    optCard.className = "quiz-option-card";
    
    const inputChecked = quizAnswers[q.id] === opt ? "checked" : "";
    
    optCard.innerHTML = `
      <input type="radio" name="quiz_option" value="${escapeHtml(opt)}" ${inputChecked} onchange="recordAptitudeAnswer(${q.id}, '${escapeHtml(opt)}')">
      <span>${escapeHtml(opt)}</span>
    `;
    list.appendChild(optCard);
  });
  
  // Nav buttons
  document.querySelector("#quizPrevBtn").disabled = (currentQuizQuestionIndex === 0);
  
  const nextBtn = document.querySelector("#quizNextBtn");
  const submitBtn = document.querySelector("#quizSubmitBtn");
  
  if (currentQuizQuestionIndex === questions.length - 1) {
    nextBtn.classList.add("hidden");
    submitBtn.classList.remove("hidden");
  } else {
    nextBtn.classList.remove("hidden");
    submitBtn.classList.add("hidden");
  }
}

function recordAptitudeAnswer(qId, val) {
  quizAnswers[qId] = val;
}

document.querySelector("#quizPrevBtn").addEventListener("click", () => {
  if (currentQuizQuestionIndex > 0) {
    currentQuizQuestionIndex--;
    renderQuizQuestion();
  }
});

document.querySelector("#quizNextBtn").addEventListener("click", () => {
  const questions = aptitudeQuestions[activeQuizCategory];
  if (currentQuizQuestionIndex < questions.length - 1) {
    currentQuizQuestionIndex++;
    renderQuizQuestion();
  }
});

document.querySelector("#quizSubmitBtn").addEventListener("click", submitAptitudeQuiz);
document.querySelector("#abortQuizBtn").addEventListener("click", exitQuizArena);

async function submitAptitudeQuiz() {
  clearInterval(quizTimerInterval);
  
  try {
    const data = await apiFetch("/api/aptitude/submit", {
      method: "POST",
      body: JSON.stringify({
        category: activeQuizCategory,
        answers: quizAnswers
      })
    });
    
    document.querySelector("#aptitudeQuizArena").classList.add("hidden");
    document.querySelector("#aptitudeScorecard").classList.remove("hidden");
    
    // Scores
    document.querySelector("#scorecardScoreVal").textContent = data.score;
    
    let remark = "Good attempt!";
    if (data.score === data.total) remark = "Perfect Score! High-tier mastery!";
    else if (data.score === 0) remark = "Review explanations to improve score.";
    document.querySelector("#scorecardRemarkText").textContent = remark;
    
    // Explanations list
    const detailsList = document.querySelector("#scorecardDetails");
    detailsList.innerHTML = "";
    
    data.details.forEach(det => {
      const card = document.createElement("div");
      card.className = "quiz-explanation-card";
      
      const scoreBadge = det.correct ? "<span class='badge badge-green'>Correct</span>" : "<span class='badge badge-purple'>Incorrect</span>";
      
      card.innerHTML = `
        <div class="explain-status-row">
          <strong>Question ${det.id}</strong>
          ${scoreBadge}
        </div>
        <p class="text-sm font-semibold">${escapeHtml(det.question)}</p>
        <p class="text-xs text-muted mt-sm">Your answer: ${escapeHtml(det.user_answer || "Unanswered")}</p>
        <p class="text-xs text-cyan">Correct Answer: ${escapeHtml(det.correct_answer)}</p>
        <div class="explain-text-body mt-sm">
          <strong>Explanation:</strong>
          <p>${escapeHtml(det.explanation)}</p>
        </div>
      `;
      detailsList.appendChild(card);
    });
    
    showToast("Aptitude quiz graded!");
  } catch(e) {
    showToast("Error submitting quiz results.");
    exitQuizArena();
  }
}

function exitQuizArena() {
  clearInterval(quizTimerInterval);
  document.querySelector("#aptitudeQuizArena").classList.add("hidden");
  document.querySelector("#aptitudeCategorySelector").classList.remove("hidden");
}

function exitScorecard() {
  document.querySelector("#aptitudeScorecard").classList.add("hidden");
  document.querySelector("#aptitudeCategorySelector").classList.remove("hidden");
}

// ============================================================================
// COMPANY PREPARATION HUB
// ============================================================================
async function loadCompanyPrepList() {
  try {
    const data = await apiFetch("/api/company/prep", { method: "POST" });
    companyPrepData = data.companies || {};
    renderCompanyCards();
  } catch(e) {
    console.error(e);
  }
}

function renderCompanyCards() {
  const container = document.querySelector("#companyCardsGrid");
  container.innerHTML = "";
  
  Object.keys(companyPrepData).forEach(key => {
    const company = companyPrepData[key];
    const card = document.createElement("div");
    card.className = "company-selection-card";
    card.onclick = () => selectCompanyDetails(key);
    
    card.innerHTML = `
      <i data-lucide="building-2" class="size-md text-cyan"></i>
      <h4>${escapeHtml(company.name)}</h4>
      <p class="text-xs text-muted mt-sm">Explore Prep Strategy</p>
    `;
    container.appendChild(card);
  });
  lucide.createIcons();
}

function selectCompanyDetails(key) {
  const company = companyPrepData[key];
  if (!company) return;
  
  document.querySelector("#selectedCompanyName").textContent = `${company.name} Prep Portal`;
  document.querySelector("#companyProcessText").textContent = company.hiring_process;
  document.querySelector("#companyStrategyText").textContent = company.strategy;
  
  // Renders accordion questions
  const qContainer = document.querySelector("#companyQuestionsContainer");
  qContainer.innerHTML = "";
  
  company.questions.forEach((qObj, idx) => {
    const item = document.createElement("div");
    item.className = "company-qa-item";
    
    item.innerHTML = `
      <div class="company-qa-header" onclick="toggleAccordion('qa_content_${idx}')">
        <span>Q: ${escapeHtml(qObj.q)}</span>
        <i data-lucide="chevron-down" class="size-xs"></i>
      </div>
      <div id="qa_content_${idx}" class="company-qa-content hidden">
        <p>${escapeHtml(qObj.a)}</p>
      </div>
    `;
    qContainer.appendChild(item);
  });
  
  document.querySelector("#companyDetailsOverlay").classList.remove("hidden");
  document.querySelector("#companyDetailsOverlay").scrollIntoView({ behavior: 'smooth' });
  lucide.createIcons();
}

function toggleAccordion(id) {
  const content = document.querySelector(`#${id}`);
  content.classList.toggle("hidden");
}

// ============================================================================
// HISTORICAL ANALYTICS AND SAVED REPORTS
// ============================================================================
let analyticsLineInstance = null;
let analyticsBarInstance = null;

async function loadAnalyticsDashboard() {
  try {
    const data = await apiFetch("/api/analytics", { method: "POST" });
    
    // Draw Line Chart
    setupAnalyticsLine(data.interview_history);
    
    // Draw Bar Chart
    setupAnalyticsBar(data.metrics);
  } catch(e) {
    console.error("Analytics load error: ", e);
  }
}

function setupAnalyticsLine(history) {
  const ctx = document.querySelector("#analyticsLineChart");
  if (!ctx) return;
  
  const labels = history.map(h => h.date);
  const dataVals = history.map(h => h.score);
  
  if (analyticsLineInstance) {
    analyticsLineInstance.data.labels = labels;
    analyticsLineInstance.data.datasets[0].data = dataVals;
    analyticsLineInstance.update();
    return;
  }

  const isLight = document.body.classList.contains("light-theme");
  const gridColor = isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)';
  const labelColor = isLight ? '#475569' : '#94A3B8';
  
  analyticsLineInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels.length > 0 ? labels : ['Mock Test 1', 'Mock Test 2'],
      datasets: [{
        label: 'Interview Scores',
        data: dataVals.length > 0 ? dataVals : [70, 85],
        borderColor: '#00D4FF',
        backgroundColor: 'rgba(0, 212, 255, 0.1)',
        tension: 0.2,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: labelColor } },
        y: { min: 0, max: 100, grid: { color: gridColor }, ticks: { color: labelColor } }
      },
      plugins: {
        legend: { labels: { color: labelColor } }
      }
    }
  });
}

function setupAnalyticsBar(metrics) {
  const ctx = document.querySelector("#analyticsBarChart");
  if (!ctx) return;
  
  const codingPercent = Math.round((metrics.coding_solved / metrics.coding_total) * 100) || 0;
  const categories = ['Aptitude', 'Coding', 'Resume Score', 'Readiness'];
  const values = [metrics.aptitude_progress || 0, codingPercent, metrics.resume_score || 0, metrics.readiness_score || 0];
  
  if (analyticsBarInstance) {
    analyticsBarInstance.data.datasets[0].data = values;
    analyticsBarInstance.update();
    return;
  }

  const isLight = document.body.classList.contains("light-theme");
  const gridColor = isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)';
  const labelColor = isLight ? '#475569' : '#94A3B8';
  
  analyticsBarInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: categories,
      datasets: [{
        label: 'SaaS Metric Score %',
        data: values,
        backgroundColor: ['#6A5CFF', '#00D4FF', '#8B5CF6', '#10B981'],
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: labelColor } },
        y: { min: 0, max: 100, grid: { color: gridColor }, ticks: { color: labelColor } }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

// Saved reports tables
let savedReportsList = [];
async function loadSavedReportsTable() {
  try {
    const data = await apiFetch("/api/reports", { method: "POST" });
    savedReportsList = data.reports || [];
    renderSavedReportsRows();
  } catch(e) {
    console.error(e);
  }
}

function renderSavedReportsRows() {
  const tbody = document.querySelector("#savedReportsTableBody");
  tbody.innerHTML = "";
  
  if (savedReportsList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No reports saved yet. Analyze your resume or check readiness to view histories.</td></tr>`;
    return;
  }
  
  savedReportsList.forEach(rep => {
    const tr = document.createElement("tr");
    
    let badgeType = "badge-cyan";
    if (rep.report_type === "interview") badgeType = "badge-purple";
    else if (rep.report_type === "readiness") badgeType = "badge-green";
    
    tr.innerHTML = `
      <td><span class="badge ${badgeType}">${escapeHtml(rep.report_type)}</span></td>
      <td>${escapeHtml(rep.title)}</td>
      <td><strong>${rep.score || '--'}</strong></td>
      <td>${escapeHtml(rep.created_at.slice(0, 16).replace('T', ' '))}</td>
      <td>
        <button type="button" class="btn btn-secondary btn-xs" onclick="expandReportInline('${rep.id}')">View Details</button>
        <button type="button" class="btn btn-danger-link text-xs ml-xs" onclick="downloadReportTxt('${rep.id}')">Download</button>
      </td>
    `;
    
    const detailsRow = document.createElement("tr");
    detailsRow.id = `rep_details_row_${rep.id}`;
    detailsRow.className = "hidden";
    detailsRow.innerHTML = `
      <td colspan="5" style="background: rgba(0,0,0,0.25); border-left: 2px solid var(--cyan);">
        <div class="report-text-field">
          ${formatMarkdownText(rep.content)}
        </div>
      </td>
    `;
    
    tbody.appendChild(tr);
    tbody.appendChild(detailsRow);
  });
}

function expandReportInline(id) {
  const el = document.querySelector(`#rep_details_row_${id}`);
  el.classList.toggle("hidden");
}

function downloadReportTxt(id) {
  const rep = savedReportsList.find(r => r.id === parseInt(id));
  if (!rep) return;
  
  const blob = new Blob([rep.content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${rep.title.replace(/\s+/g, '_')}_Report.txt`;
  a.click();
}

// ============================================================================
// SHARING & EXPORTS CONTROLLER (Modals actions)
// ============================================================================
let currentShareMessageText = "Practicing placements preparation rounds on AI Placement Assistant Pro! Join now!";
function triggerShareModal(text) {
  currentShareMessageText = text;
  document.querySelector("#shareLinkInput").value = `http://localhost:8000/shared/chat_${Math.random().toString(36).substring(7)}`;
  openModal("shareModal");
}

function executeShareAction(platform) {
  const url = encodeURIComponent(document.querySelector("#shareLinkInput").value);
  const text = encodeURIComponent(currentShareMessageText);
  
  const shareUrls = {
    whatsapp: `https://api.whatsapp.com/send?text=${text}%20${url}`,
    telegram: `https://telegram.me/share/url?url=${url}&text=${text}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    twitter: `https://twitter.com/intent/tweet?url=${url}&text=${text}`,
    email: `mailto:?subject=AI%20Placement%20Assistant%20Pro%20Report&body=${text}%0A${url}`
  };
  
  if (shareUrls[platform]) {
    window.open(shareUrls[platform], "_blank");
  }
}

document.querySelector("#copyLinkBtn").addEventListener("click", () => {
  const link = document.querySelector("#shareLinkInput");
  navigator.clipboard.writeText(link.value).then(() => {
    showToast("Copied shareable link!");
  });
});

// ============================================================================
// FORMATTING HELPERS
// ============================================================================
function formatMarkdownText(text) {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function autoExpandTextarea() {
  const el = document.querySelector("#messageInput");
  el.style.height = "auto";
  el.style.height = (el.scrollHeight) + "px";
}

function base64ToBlob(base64Data, contentType) {
  const byteCharacters = atob(base64Data);
  const byteArrays = [];
  
  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }
  
  return new Blob(byteArrays, { type: contentType });
}

function findScoreInText(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}[^0-9]*(\\d{1,3})`, "i"));
    if (match) {
      return Math.min(Number(match[1]), 100);
    }
  }
  return null;
}
