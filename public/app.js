/* Simple self-hosted Pomodoro timer.
   State (settings + tasks) is persisted to localStorage. */

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    pomodoro: 25,
    shortBreak: 5,
    longBreak: 15,
    autoBreak: false,
    autoPomo: false,
    interval: 4, // long break after this many pomodoros
    sound: true,
    volume: 50,
  };

  const MODE_LABEL = {
    pomodoro: "Time to focus!",
    shortBreak: "Time for a break!",
    longBreak: "Time for a long break!",
  };

  // ---------- persistence ----------
  const load = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  };
  const save = (key, val) => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {}
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS, load("pomodoro_settings", {}));
  let tasks = load("pomodoro_tasks", []);

  // ---------- runtime state ----------
  let mode = "pomodoro";
  let remaining = settings.pomodoro * 60; // seconds
  let running = false;
  let ticker = null;
  let endTime = 0; // epoch ms when current run ends
  let completedPomodoros = 0;
  let activeTaskId = null;

  // ---------- element refs ----------
  const $ = (sel) => document.querySelector(sel);
  const body = document.body;
  const timeEl = $("#time");
  const startBtn = $("#startBtn");
  const skipBtn = $("#skipBtn");
  const roundInfo = $("#roundInfo");
  const focusHint = $("#focusHint");
  const modeButtons = document.querySelectorAll("[data-set-mode]");

  const taskList = $("#taskList");
  const addTaskBtn = $("#addTaskBtn");
  const taskForm = $("#taskForm");
  const taskInput = $("#taskInput");
  const taskEst = $("#taskEst");
  const cancelTask = $("#cancelTask");
  const clearFinished = $("#clearFinished");

  // settings modal
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
  };

  // ---------- timer helpers ----------
  const durationFor = (m) => settings[m] * 60;

  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function render() {
    timeEl.textContent = fmt(remaining);
    document.title = `${fmt(remaining)} — ${
      mode === "pomodoro" ? "Focus" : "Break"
    }`;
    focusHint.textContent = MODE_LABEL[mode];
    roundInfo.textContent = `#${completedPomodoros + 1}`;
  }

  function setMode(next, { keepRunning = false } = {}) {
    mode = next;
    body.dataset.mode = next;
    modeButtons.forEach((b) =>
      b.classList.toggle("is-active", b.dataset.setMode === next)
    );
    if (!keepRunning) {
      stop();
      remaining = durationFor(next);
      render();
    }
  }

  function start() {
    if (running) return;
    running = true;
    endTime = Date.now() + remaining * 1000;
    startBtn.textContent = "PAUSE";
    startBtn.classList.add("is-running");
    skipBtn.classList.add("is-visible");
    ticker = setInterval(tick, 250);
  }

  function pause() {
    running = false;
    clearInterval(ticker);
    ticker = null;
    startBtn.textContent = "START";
    startBtn.classList.remove("is-running");
  }

  function stop() {
    pause();
    skipBtn.classList.remove("is-visible");
  }

  function tick() {
    const secsLeft = Math.round((endTime - Date.now()) / 1000);
    remaining = Math.max(0, secsLeft);
    render();
    if (remaining <= 0) complete();
  }

  function complete() {
    stop();
    playAlarm();

    if (mode === "pomodoro") {
      completedPomodoros += 1;
      incrementActiveTask();
      const useLong = completedPomodoros % settings.interval === 0;
      const nextMode = useLong ? "longBreak" : "shortBreak";
      setMode(nextMode);
      if (settings.autoBreak) start();
    } else {
      setMode("pomodoro");
      if (settings.autoPomo) start();
    }
    notify();
  }

  // ---------- alarm ----------
  let audioCtx = null;
  function playAlarm() {
    if (!settings.sound) return;
    try {
      audioCtx =
        audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const vol = (settings.volume / 100) * 0.4;
      // three short beeps
      [0, 0.35, 0.7].forEach((offset) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0, audioCtx.currentTime + offset);
        gain.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + offset + 0.02);
        gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + offset + 0.25);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + offset);
        osc.stop(audioCtx.currentTime + offset + 0.3);
      });
    } catch (_) {}
  }

  function notify() {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    try {
      new Notification(
        mode === "pomodoro" ? "Break over — time to focus!" : "Pomodoro done!",
        { body: MODE_LABEL[mode], silent: true }
      );
    } catch (_) {}
  }

  // ---------- tasks ----------
  function renderTasks() {
    taskList.innerHTML = "";
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
      check.setAttribute("aria-label", "Mark done");

      const name = document.createElement("span");
      name.className = "task__name";
      name.textContent = t.name;

      const est = document.createElement("span");
      est.className = "task__est";
      est.textContent = `${t.done_count || 0}/${t.est}`;

      const del = document.createElement("button");
      del.className = "task__del";
      del.type = "button";
      del.textContent = "🗑";
      del.setAttribute("aria-label", "Delete task");

      li.append(check, name, est, del);
      taskList.appendChild(li);
    });
  }

  function addTask(name, est) {
    tasks.push({
      id: Date.now().toString(36),
      name: name,
      est: est,
      done_count: 0,
      done: false,
    });
    save("pomodoro_tasks", tasks);
    renderTasks();
  }

  function incrementActiveTask() {
    const t = tasks.find((x) => x.id === activeTaskId);
    if (t) {
      t.done_count = (t.done_count || 0) + 1;
      save("pomodoro_tasks", tasks);
      renderTasks();
    }
  }

  // task list interactions (event delegation)
  taskList.addEventListener("click", (e) => {
    const li = e.target.closest(".task");
    if (!li) return;
    const id = li.dataset.id;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;

    if (e.target.classList.contains("task__check")) {
      t.done = !t.done;
      save("pomodoro_tasks", tasks);
      renderTasks();
    } else if (e.target.classList.contains("task__del")) {
      tasks = tasks.filter((x) => x.id !== id);
      if (activeTaskId === id) activeTaskId = null;
      save("pomodoro_tasks", tasks);
      renderTasks();
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
    save("pomodoro_tasks", tasks);
    renderTasks();
  });

  // ---------- settings modal ----------
  function fillSettingsForm() {
    f.pomodoro.value = settings.pomodoro;
    f.short.value = settings.shortBreak;
    f.long.value = settings.longBreak;
    f.autoBreak.checked = settings.autoBreak;
    f.autoPomo.checked = settings.autoPomo;
    f.interval.value = settings.interval;
    f.sound.checked = settings.sound;
    f.volume.value = settings.volume;
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
    save("pomodoro_settings", settings);

    // reset the current (non-running) timer to reflect new durations
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

  // ---------- top-level controls ----------
  startBtn.addEventListener("click", () => {
    // browsers require a user gesture to unlock audio
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    running ? pause() : start();
  });

  skipBtn.addEventListener("click", () => {
    if (mode === "pomodoro") {
      completedPomodoros += 1;
      const useLong = completedPomodoros % settings.interval === 0;
      setMode(useLong ? "longBreak" : "shortBreak");
    } else {
      setMode("pomodoro");
    }
  });

  modeButtons.forEach((b) => {
    b.addEventListener("click", () => {
      if (running && !confirm("The timer is still running — switch anyway?"))
        return;
      setMode(b.dataset.setMode);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.code === "Space") {
      e.preventDefault();
      startBtn.click();
    } else if (e.key === "Escape" && !settingsBackdrop.hidden) {
      closeModal();
    }
  });

  // ---------- init ----------
  setMode("pomodoro");
  renderTasks();
  render();
})();
