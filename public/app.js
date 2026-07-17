/* Pomodoro — front-end logic.
   Timer + dial rendering, with settings and tasks persisted through a small
   REST API backed by SQLite (see server.py). If the API is unreachable the
   app still runs for the session; it just won't persist. */

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    pomodoro: 25,
    shortBreak: 5,
    longBreak: 15,
    autoBreak: false,
    autoPomo: false,
    interval: 4,
    sound: true,
    volume: 50,
    tick: false,
    tickVolume: 50,
  };

  const MODE_LABEL = {
    pomodoro: "Focus",
    shortBreak: "Short break",
    longBreak: "Long break",
  };
  const MODE_ALERT = {
    pomodoro: "Time to focus.",
    shortBreak: "Time for a short break.",
    longBreak: "Time for a long break.",
  };

  // ---------- tiny API client ----------
  const api = {
    async get(path) {
      const r = await fetch(path);
      if (!r.ok) throw new Error(r.status);
      return r.json();
    },
    async send(method, path, body) {
      const r = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!r.ok) throw new Error(r.status);
      return r.status === 204 ? null : r.json();
    },
  };

  // ---------- state ----------
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let tasks = [];

  let mode = "pomodoro";
  let remaining = settings.pomodoro * 60; // seconds
  let running = false;
  let ticker = null;
  let endTime = 0;
  let lastSecond = null; // last whole second we played a tick for
  let completedPomodoros = 0;
  let activeTaskId = null;

  // ---------- element refs ----------
  const $ = (s) => document.querySelector(s);
  const body = document.body;
  const timeEl = $("#time");
  const modeLabelEl = $("#modeLabel");
  const startBtn = $("#startBtn");
  const skipBtn = $("#skipBtn");
  const cycleEl = $("#cycle");
  const sessionCountEl = $("#sessionCount");
  const modeButtons = document.querySelectorAll("[data-set-mode]");

  const taskList = $("#taskList");
  const addTaskBtn = $("#addTaskBtn");
  const taskForm = $("#taskForm");
  const taskInput = $("#taskInput");
  const taskEst = $("#taskEst");
  const cancelTask = $("#cancelTask");
  const clearFinished = $("#clearFinished");

  const settingsBackdrop = $("#settingsBackdrop");
  const openSettings = $("#openSettings");
  const closeSettings = $("#closeSettings");
  const saveSettings = $("#saveSettings");
  const f = {
    pomodoro: $("#setPomodoro"),
    short: $("#setShort"),
    long: $("#setLong"),
    autoBreak: $("#setAutoBreak"),
    autoPomo: $("#setAutoPomo"),
    interval: $("#setInterval"),
    sound: $("#setSound"),
    volume: $("#setVolume"),
    tick: $("#setTick"),
    tickVolume: $("#setTickVolume"),
  };

  // ---------- dial ----------
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ARC_R = 96;
  const CIRC = 2 * Math.PI * ARC_R;
  const arcEl = $("#dialArc");
  const pipG = $("#dialPipG");

  function buildTicks() {
    const g = $("#dialTicks");
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", "120");
      line.setAttribute("y1", "4");
      line.setAttribute("x2", "120");
      line.setAttribute("y2", major ? "17" : "11");
      line.setAttribute("transform", `rotate(${i * 6} 120 120)`);
      line.setAttribute("class", major ? "tick tick--major" : "tick");
      g.appendChild(line);
    }
    arcEl.style.strokeDasharray = String(CIRC);
  }

  function setArc(frac) {
    // frac = 1 → full ring; counts down toward 0 (ring unwinds back to top)
    arcEl.style.strokeDashoffset = String(CIRC * (1 - frac));
    pipG.style.transform = `rotate(${360 * frac}deg)`;
  }

  // ---------- cycle pips ----------
  function buildCycle() {
    cycleEl.textContent = "";
    for (let i = 0; i < settings.interval; i++) {
      const pip = document.createElement("span");
      pip.className = "cycle__pip";
      cycleEl.appendChild(pip);
    }
    updateCycle();
  }
  function updateCycle() {
    const filled = completedPomodoros % settings.interval;
    cycleEl.querySelectorAll(".cycle__pip").forEach((p, i) => {
      p.classList.toggle("is-filled", i < filled);
    });
  }

  // ---------- render ----------
  const durationFor = (m) => settings[m] * 60;

  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function render() {
    const total = durationFor(mode);
    timeEl.textContent = fmt(remaining);
    modeLabelEl.textContent = MODE_LABEL[mode];
    setArc(total > 0 ? remaining / total : 0);
    sessionCountEl.textContent = `Session ${completedPomodoros + 1}`;
    document.title = `${fmt(remaining)} · ${MODE_LABEL[mode]}`;
    updateCycle();
  }

  function setMode(next) {
    mode = next;
    body.dataset.mode = next;
    modeButtons.forEach((b) => {
      const on = b.dataset.setMode === next;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    stop();
    remaining = durationFor(next);
    render();
  }

  // ---------- timer ----------
  function start() {
    if (running) return;
    running = true;
    endTime = Date.now() + remaining * 1000;
    lastSecond = remaining; // don't fire a tick on the very first frame
    startBtn.textContent = "Pause";
    startBtn.classList.add("is-running");
    ticker = setInterval(tick, 250);
  }
  function pause() {
    running = false;
    clearInterval(ticker);
    ticker = null;
    startBtn.textContent = "Start";
    startBtn.classList.remove("is-running");
  }
  function stop() {
    pause();
  }
  function tick() {
    remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    render();
    if (running && remaining > 0 && remaining !== lastSecond) {
      lastSecond = remaining;
      playTick();
    }
    if (remaining <= 0) complete();
  }

  // Leaving a finished focus session — shared by the timer completing on its
  // own and by the Skip button, so both credit the active task and both count
  // toward the long-break cycle.
  function finishPomodoro() {
    completedPomodoros += 1;
    incrementActiveTask();
    const useLong = completedPomodoros % settings.interval === 0;
    setMode(useLong ? "longBreak" : "shortBreak");
  }

  function complete() {
    stop();
    playAlarm();
    if (mode === "pomodoro") {
      finishPomodoro();
      if (settings.autoBreak) start();
    } else {
      setMode("pomodoro");
      if (settings.autoPomo) start();
    }
    notify();
  }

  // ---------- audio (synthesized, no audio files) ----------
  // The AudioContext must be created/resumed during a user gesture, or the
  // browser keeps it suspended and nothing is audible. ensureAudio() is called
  // from the Start click for exactly that reason.
  let audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (_) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function beep(freq, startAt, dur, peak) {
    const t = audioCtx.currentTime + startAt;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.02);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function playAlarm() {
    if (!settings.sound || !ensureAudio()) return;
    const peak = (settings.volume / 100) * 0.4;
    beep(880, 0, 0.25, peak);
    beep(880, 0.35, 0.25, peak);
    beep(880, 0.7, 0.25, peak);
  }

  // short mechanical "tick" for button presses
  function playClick() {
    if (!settings.sound || !ensureAudio()) return;
    const peak = (settings.volume / 100) * 0.22 || 0.001;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(330, t + 0.05);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  // per-second ticking while the timer runs (own toggle + volume)
  let tockParity = false;
  function playTick() {
    if (!settings.tick || !ensureAudio()) return;
    const peak = (settings.tickVolume / 100) * 0.18;
    if (peak <= 0) return;
    tockParity = !tockParity;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = tockParity ? 1150 : 900; // tick / tock
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  function notify() {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    try {
      new Notification(MODE_ALERT[mode], { silent: true });
    } catch (_) {}
  }

  // ---------- tasks (rendering) ----------
  function renderTasks() {
    taskList.textContent = "";
    tasks.forEach((t) => {
      const li = document.createElement("li");
      li.className =
        "task" +
        (t.done ? " is-done" : "") +
        (t.id === activeTaskId ? " is-active" : "");
      li.dataset.id = t.id;

      const check = document.createElement("button");
      check.className = "task__check";
      check.type = "button";
      check.textContent = "✓";
      check.setAttribute("aria-label", t.done ? "Mark not done" : "Mark done");

      const name = document.createElement("span");
      name.className = "task__name";
      name.textContent = t.name;

      const est = document.createElement("span");
      est.className = "task__est";
      est.textContent = `${t.done_count || 0}/${t.est}`;

      const del = document.createElement("button");
      del.className = "task__del";
      del.type = "button";
      del.textContent = "✕";
      del.setAttribute("aria-label", "Delete task");

      li.append(check, name, est, del);
      taskList.appendChild(li);
    });
  }

  // ---------- tasks (persistence) ----------
  async function addTask(name, est) {
    try {
      const task = await api.send("POST", "/api/tasks", { name, est });
      tasks.push(task);
    } catch (_) {
      // offline fallback: local-only task
      tasks.push({
        id: `local-${Date.now()}`,
        name,
        est,
        done_count: 0,
        done: false,
      });
    }
    renderTasks();
  }

  function patchTask(id, changes) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, changes);
    renderTasks();
    api.send("PATCH", `/api/tasks/${id}`, changes).catch(() => {});
  }

  function incrementActiveTask() {
    const t = tasks.find((x) => x.id === activeTaskId);
    if (t) patchTask(t.id, { done_count: (t.done_count || 0) + 1 });
  }

  taskList.addEventListener("click", (e) => {
    const li = e.target.closest(".task");
    if (!li) return;
    const t = tasks.find((x) => String(x.id) === li.dataset.id);
    if (!t) return;
    const id = t.id;

    if (e.target.classList.contains("task__check")) {
      patchTask(id, { done: !t.done });
    } else if (e.target.classList.contains("task__del")) {
      tasks = tasks.filter((x) => x.id !== id);
      if (activeTaskId === id) activeTaskId = null;
      renderTasks();
      api.send("DELETE", `/api/tasks/${id}`).catch(() => {});
    } else {
      activeTaskId = activeTaskId === id ? null : id;
      renderTasks();
    }
  });

  // add-task form
  function openTaskForm() {
    taskForm.hidden = false;
    addTaskBtn.hidden = true;
    taskInput.value = "";
    taskEst.value = 1;
    taskInput.focus();
  }
  function closeTaskForm() {
    taskForm.hidden = true;
    addTaskBtn.hidden = false;
  }
  addTaskBtn.addEventListener("click", openTaskForm);
  cancelTask.addEventListener("click", closeTaskForm);
  taskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = taskInput.value.trim();
    if (!name) return;
    const est = Math.min(99, Math.max(1, parseInt(taskEst.value, 10) || 1));
    addTask(name, est);
    closeTaskForm();
  });
  clearFinished.addEventListener("click", () => {
    tasks = tasks.filter((t) => !t.done);
    renderTasks();
    api.send("POST", "/api/tasks/clear-done").catch(() => {});
  });

  // ---------- settings ----------
  function fillSettingsForm() {
    f.pomodoro.value = settings.pomodoro;
    f.short.value = settings.shortBreak;
    f.long.value = settings.longBreak;
    f.autoBreak.checked = settings.autoBreak;
    f.autoPomo.checked = settings.autoPomo;
    f.interval.value = settings.interval;
    f.sound.checked = settings.sound;
    f.volume.value = settings.volume;
    f.tick.checked = settings.tick;
    f.tickVolume.value = settings.tickVolume;
  }
  function applySettingsForm() {
    const clamp = (v, min, max, dflt) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? dflt : Math.min(max, Math.max(min, n));
    };
    settings.pomodoro = clamp(f.pomodoro.value, 1, 180, 25);
    settings.shortBreak = clamp(f.short.value, 1, 180, 5);
    settings.longBreak = clamp(f.long.value, 1, 180, 15);
    settings.autoBreak = f.autoBreak.checked;
    settings.autoPomo = f.autoPomo.checked;
    settings.interval = clamp(f.interval.value, 1, 12, 4);
    settings.sound = f.sound.checked;
    settings.volume = clamp(f.volume.value, 0, 100, 50);
    settings.tick = f.tick.checked;
    settings.tickVolume = clamp(f.tickVolume.value, 0, 100, 50);

    api.send("PUT", "/api/settings", settings).catch(() => {});

    buildCycle();
    if (!running) {
      remaining = durationFor(mode);
      render();
    }
  }

  openSettings.addEventListener("click", () => {
    fillSettingsForm();
    settingsBackdrop.hidden = false;
  });
  function closeModal() {
    settingsBackdrop.hidden = true;
  }
  closeSettings.addEventListener("click", closeModal);
  saveSettings.addEventListener("click", () => {
    applySettingsForm();
    closeModal();
  });
  settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === settingsBackdrop) closeModal();
  });

  // ---------- controls ----------
  startBtn.addEventListener("click", () => {
    ensureAudio(); // unlock the audio context on this user gesture
    playClick(); // audible button-press feedback
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    running ? pause() : start();
  });
  skipBtn.addEventListener("click", () => {
    if (mode === "pomodoro") {
      finishPomodoro();
    } else {
      setMode("pomodoro");
    }
  });
  modeButtons.forEach((b) => {
    b.addEventListener("click", () => {
      if (running && !confirm("The timer is running — switch anyway?")) return;
      setMode(b.dataset.setMode);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      startBtn.click();
    } else if (e.key === "Escape" && !settingsBackdrop.hidden) {
      closeModal();
    }
  });

  // ---------- init ----------
  async function init() {
    buildTicks();
    setMode("pomodoro");
    try {
      const state = await api.get("/api/state");
      if (state.settings)
        settings = Object.assign({}, DEFAULT_SETTINGS, state.settings);
      if (Array.isArray(state.tasks)) tasks = state.tasks;
    } catch (_) {
      /* backend unavailable — run with defaults, no persistence */
    }
    buildCycle();
    if (!running) remaining = durationFor(mode);
    render();
    renderTasks();
  }

  init();
})();
