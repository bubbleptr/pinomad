import "./styles.css";

// Animation writes go through classes, SVG attributes, SMIL beginElement(), and
// the CSSOM (el.style.x = …): all allowed under the page's style-src 'self',
// unlike style="" in markup or setAttribute("style", …).

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const lang = document.documentElement.lang.startsWith("zh") ? "zh" : "en";

const strings = {
  en: {
    durableIdle: "Start a run, then pull the plug while it's going.",
    durableRunning: "Running. Each finished call plants a flag: a checkpoint.",
    durableCrashed: "The host is gone. Only the half-finished call is lost.",
    durableResumed: (flag) => `Restarted. Picking up from flag ${flag}.`,
    durableRestartedEmpty: "Restarted. No flag yet, so it starts from the top.",
    durableDone: "Done. No call behind a flag ran twice.",
    durableDoneClean: "Done. Next time, pull the plug while it runs.",
    start: "Start a run",
    pull: "Pull the plug",
    again: "Run it again",
    relayIdle: "Pick where you're sending from.",
    relayDirect: "Same LAN or tailnet: straight to the host.",
    relayRelay: "Can't reach home: through the relay, which only forwards ciphertext.",
  },
  zh: {
    durableIdle: "点「开始一个任务」，趁它在跑拔掉电源。",
    durableRunning: "跑着呢，每走完一步插一面旗，也就是一个检查点。",
    durableCrashed: "宿主进程没了。只有做到一半的那一步作废。",
    durableResumed: (flag) => `重启了，从第 ${flag} 面旗接着跑。`,
    durableRestartedEmpty: "重启了。还没插旗，只能从头开始。",
    durableDone: "跑完了，插过旗的步骤一步都没重做。",
    durableDoneClean: "跑完了。下次趁它在跑时拔掉电源试试。",
    start: "开始一个任务",
    pull: "拔掉电源",
    again: "再来一次",
    relayIdle: "选一个地方发条消息。",
    relayDirect: "同一个局域网或 tailnet：直接连到宿主。",
    relayRelay: "连不上家里：走中继。中继转发的是密文，看不到内容。",
  },
}[lang];

function restartClass(el, name) {
  el.classList.remove(name);
  void el.getBoundingClientRect();
  el.classList.add(name);
}

function beginSmil(el) {
  for (const anim of el.querySelectorAll("animate, animateMotion")) anim.beginElement();
}

// Keep a moving part in view when a diagram is wider than its scroller (phones).
function follow(scroller, svg, x) {
  if (scroller.scrollWidth <= scroller.clientWidth) return;
  const box = svg.viewBox.baseVal;
  scroller.scrollLeft = (x / box.width) * svg.clientWidth - scroller.clientWidth / 2;
}

// —— Copy buttons ship hidden; without JS (or the async clipboard API) the code
// block is still plain selectable text. ——
if (navigator.clipboard) {
  for (const button of document.querySelectorAll("[data-copy]")) {
    const target = document.getElementById(button.dataset.copy);
    if (!target) continue;
    const label = button.textContent;
    const status = button.parentElement.querySelector("[data-copy-status]");
    let timer;
    button.hidden = false;
    button.addEventListener("click", async () => {
      const text = target.textContent.replace(/[ \t]*#.*$/gm, "").trim();
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = button.dataset.done;
      } catch {
        button.textContent = button.dataset.failed;
      }
      if (status) status.textContent = button.textContent;
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.textContent = label;
        if (status) status.textContent = "";
      }, 2000);
    });
  }
}

// —— Hero: the drawing plays in once per session; a device replays its packet
// on hover or tap. ——
function setupHero(art) {
  const copy = document.querySelector(".hero-copy");
  const INTRO_KEY = "pinomad:hero-intro";

  function send(device) {
    const packet = art.querySelector(`[data-packet="${device}"]`);
    const route = art.querySelector(`.route[data-route="${device}"]`);
    const bubble = art.querySelector(`[data-device="${device}"] .bubble`);
    if (packet.dataset.busy) return;
    packet.dataset.busy = "1";
    route.classList.add("is-hot");
    beginSmil(packet);
    setTimeout(() => restartClass(bubble, "pop"), 800);
    setTimeout(() => {
      route.classList.remove("is-hot");
      delete packet.dataset.busy;
    }, 950);
  }

  function seenIntro() {
    try {
      if (sessionStorage.getItem(INTRO_KEY)) return true;
      sessionStorage.setItem(INTRO_KEY, "1");
    } catch {
      // Storage blocked: play it; it costs nothing.
    }
    return false;
  }

  if (!reduceMotion.matches && !seenIntro()) {
    art.classList.add("is-intro");
    copy.classList.add("is-intro-copy");
    setTimeout(() => ["mac", "web", "phone"].forEach(send), 2300);
    setTimeout(() => {
      art.classList.remove("is-intro");
      copy.classList.remove("is-intro-copy");
    }, 3800);
  }

  for (const device of art.querySelectorAll("[data-device]")) {
    const play = () => {
      if (!reduceMotion.matches) send(device.dataset.device);
    };
    device.addEventListener("pointerenter", play);
    device.addEventListener("click", play);
  }
}

// —— Durable: start a run and pull the plug whenever you like. The run resumes
// from the last flag it planted, never from the crash point and never from the
// start once a flag is down — that's the claim the diagram makes. ——
function setupDurable(root) {
  const svg = root.querySelector(".durable-art");
  const scroller = root.querySelector("[data-scroll]");
  const button = root.querySelector("[data-durable-button]");
  const status = root.querySelector("[data-durable-status]");
  const runner = svg.querySelector("[data-runner]");
  const trail = svg.querySelector(".trail");
  const crash = svg.querySelector("[data-crash]");
  const resume = svg.querySelector("[data-resume]");
  const resumeArc = svg.querySelector("[data-resume-arc]");
  const resumeHead = svg.querySelector("[data-resume-head]");
  const resumeNote = svg.querySelector("[data-resume-note]");
  const flags = [...svg.querySelectorAll(".flag")].map((el) => ({ el, x: Number(el.dataset.x) }));

  const START = 60;
  const END = 900;
  const SPEED = 0.11; // viewBox units per ms: about 7.6 s for the whole run
  const BOLT_X = 664;

  let state = "idle";
  let x = END;
  let planted = 0;
  let crashes = 0;
  let last = 0;
  let frame = 0;

  function lastFlagX() {
    return planted ? flags[planted - 1].x : START;
  }

  // With reduced motion the ghost steps from flag to flag instead of gliding.
  function place() {
    const shown = reduceMotion.matches && x < END ? lastFlagX() : x;
    runner.style.transform = `translateX(${shown}px)`;
    trail.style.strokeDashoffset = String(END - shown);
    follow(scroller, svg, shown);
  }

  function tick(now) {
    x = Math.min(END, x + (now - last) * SPEED);
    last = now;
    while (planted < flags.length && x >= flags[planted].x) {
      flags[planted].el.classList.remove("is-down");
      planted += 1;
    }
    place();
    if (x >= END) finish();
    else frame = requestAnimationFrame(tick);
  }

  function run() {
    state = "running";
    button.textContent = strings.pull;
    button.disabled = false;
    status.textContent = strings.durableRunning;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function start() {
    x = START;
    planted = 0;
    crashes = 0;
    for (const flag of flags) flag.el.classList.add("is-down");
    crash.classList.add("is-hidden");
    resume.classList.add("is-hidden");
    runner.classList.remove("is-down");
    place();
    run();
  }

  function pull() {
    cancelAnimationFrame(frame);
    state = "crashed";
    crashes += 1;
    button.disabled = true;
    status.textContent = strings.durableCrashed;

    const crashX = x;
    const resumeX = lastFlagX();
    crash.style.transform = `translateX(${crashX - BOLT_X}px)`;
    crash.classList.remove("is-hidden");
    resume.classList.add("is-hidden");
    runner.classList.add("is-down");
    trail.classList.add("is-retracting");
    trail.style.strokeDashoffset = String(END - resumeX);

    setTimeout(() => {
      trail.classList.remove("is-retracting");
      resumeArc.setAttribute(
        "d",
        `M${crashX} 232 C ${crashX - 8} 270, ${resumeX + 8} 270, ${resumeX + 2} 236`,
      );
      resumeHead.setAttribute("d", `M${resumeX - 4} 244 L ${resumeX + 2} 233 L ${resumeX + 11} 242`);
      resumeNote.setAttribute("x", String((crashX + resumeX) / 2));
      resume.classList.toggle("is-hidden", crashX - resumeX < 4);
      x = resumeX;
      place();
      runner.classList.remove("is-down");
      status.textContent = planted
        ? strings.durableResumed(planted)
        : strings.durableRestartedEmpty;
      setTimeout(run, 900);
    }, 1100);
  }

  function finish() {
    state = "done";
    button.textContent = strings.again;
    status.textContent = crashes ? strings.durableDone : strings.durableDoneClean;
  }

  follow(scroller, svg, 640); // phones: open on the crash, the point of the story
  button.hidden = false;
  button.textContent = strings.start;
  status.textContent = strings.durableIdle;
  button.addEventListener("click", () => {
    if (state === "running") pull();
    else if (state !== "crashed") start();
  });
}

// —— Relay: send a sealed message by either route. While it passes through the
// relay, the relay's view churns through ciphertext. ——
function setupRelay(root) {
  const svg = root.querySelector(".relay-art");
  const scroller = root.querySelector("[data-scroll]");
  const buttons = root.querySelector("[data-relay-buttons]");
  const status = root.querySelector("[data-relay-status]");
  const cipher = svg.querySelector("[data-cipher]");
  const phoneBubble = svg.querySelector('[data-bubble="phone"]');
  const hostBubble = svg.querySelector('[data-bubble="host"]');
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // Seconds of flight, and the share of the relay route spent inside the relay box.
  const timing = { direct: { dur: 1600 }, relay: { dur: 2600, inside: [0.37, 0.68] } };
  let busy = false;

  function scramble() {
    let out = "";
    for (let i = 0; i < 13; i += 1) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    cipher.textContent = `${out}=`;
  }

  function followPacket(packet, until) {
    const step = () => {
      const box = packet.getBoundingClientRect();
      const origin = svg.getBoundingClientRect();
      follow(scroller, svg, ((box.left + box.width / 2 - origin.left) / origin.width) * 960);
      if (performance.now() < until) requestAnimationFrame(step);
    };
    if (scroller.scrollWidth > scroller.clientWidth) requestAnimationFrame(step);
  }

  function send(route) {
    if (busy) return;
    busy = true;
    const { dur, inside } = timing[route];
    const path = svg.querySelector(`.route[data-route="${route}"]`);
    const packet = svg.querySelector(`[data-packet="${route}"]`);
    status.textContent = route === "relay" ? strings.relayRelay : strings.relayDirect;
    restartClass(phoneBubble, "pop");
    hostBubble.classList.remove("pop");

    if (reduceMotion.matches) {
      if (route === "relay") scramble();
      busy = false;
      return;
    }

    hostBubble.classList.add("is-waiting");
    path.classList.add("is-hot");
    beginSmil(packet);
    followPacket(packet, performance.now() + dur);
    if (inside) {
      let churn;
      setTimeout(() => {
        churn = setInterval(scramble, 70);
      }, dur * inside[0]);
      setTimeout(() => clearInterval(churn), dur * inside[1]);
    }
    setTimeout(() => {
      path.classList.remove("is-hot");
      hostBubble.classList.remove("is-waiting");
      restartClass(hostBubble, "pop");
      busy = false;
    }, dur);
  }

  follow(scroller, svg, 480); // phones: open on the relay
  buttons.hidden = false;
  status.textContent = strings.relayIdle;
  for (const button of buttons.querySelectorAll("[data-relay-send]")) {
    button.addEventListener("click", () => send(button.dataset.relaySend));
  }
}

const heroArt = document.querySelector(".hero-art");
if (heroArt) setupHero(heroArt);
const durable = document.querySelector("[data-durable]");
if (durable) setupDurable(durable);
const relay = document.querySelector("[data-relay]");
if (relay) setupRelay(relay);
