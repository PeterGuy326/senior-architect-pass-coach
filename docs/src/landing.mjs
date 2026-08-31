const copyButtons = document.querySelectorAll("[data-copy]");

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const value = button.dataset.copy || "";
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "已复制";
      button.dataset.copied = "true";
      window.setTimeout(() => {
        button.textContent = button.closest(".command-card") ? "复制命令" : "复制";
        delete button.dataset.copied;
      }, 1600);
    } catch {
      button.textContent = "请手动复制";
    }
  });
}

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
}
