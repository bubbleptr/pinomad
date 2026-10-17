import "./styles.css";

// Copy buttons ship hidden; without JS (or without the async clipboard API) the
// code block is still plain selectable text.
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
