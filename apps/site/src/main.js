import "./styles.css";

// Animation writes go through classes, SVG attributes, and the CSSOM
// (el.style.x = …): all allowed under the page's style-src 'self', unlike
// style="" in markup or setAttribute("style", …).

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
  },
}[lang];

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

  // With reduced motion the runner steps from flag to flag instead of gliding.
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

const durable = document.querySelector("[data-durable]");
if (durable) setupDurable(durable);

// —— Header: sticks once JS is here, floats a frosted pill once the page moves,
// and underlines the section being read. ——
function setupHeader(header) {
  const links = [...header.querySelectorAll(".nav-sections a")];
  const sections = links.map((a) => document.getElementById(a.hash.slice(1)));
  let frame = 0;

  function update() {
    frame = 0;
    // Float past 24px, settle only under 8px, so a nudge or rubber-band near
    // the top can't flip it back and forth.
    if (scrollY > 24) header.classList.add("is-floating");
    else if (scrollY < 8) header.classList.remove("is-floating");

    // The current section is the last one whose top has passed a third of the
    // way down; at the very bottom, the last section.
    let current = -1;
    sections.forEach((section, i) => {
      if (section.getBoundingClientRect().top <= innerHeight / 3) current = i;
    });
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) {
      current = sections.length - 1;
    }
    links.forEach((a, i) => {
      if (i === current) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    });
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  // Settle the state before the pill exists, so a reload mid-page shows it
  // already in place instead of animating it in.
  update();
  header.setAttribute("data-sticky", "");
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
}

const header = document.querySelector(".site-header");
if (header) setupHeader(header);

// Blocks that start below the first screen fade up once as they scroll in.
// Anything on screen at load is left alone, so the first paint never animates.
function setupReveal() {
  const observer = new IntersectionObserver(
    (entries) => {
      let shown = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.style.transitionDelay = `${Math.min(shown, 3) * 80}ms`;
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
        shown += 1;
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  const blocks = document.querySelectorAll(
    ".section-head, .shot-phone, .panel, .feature-row > *, .more, .client, .code-card, .closing .wrap",
  );
  for (const block of blocks) {
    if (block.getBoundingClientRect().top < innerHeight) continue;
    block.classList.add("reveal");
    observer.observe(block);
  }
}

if (!reduceMotion.matches) setupReveal();
