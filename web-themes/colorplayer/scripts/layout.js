// Shared layout and OBS scene theme. Component animation clocks stay independent.
(() => {
  const stage = document.querySelector(".stage");
  function fitStage() {
    const scale = Math.min(window.innerWidth / stage.offsetWidth, window.innerHeight / stage.offsetHeight);
    stage.style.setProperty("--scale", String(scale));
  }
  fitStage();
  window.addEventListener("resize", fitStage);

  function applyScene(scene) {
    const name = String(scene?.name ?? "").toLowerCase();
    document.documentElement.dataset.theme =
      name.lastIndexOf("[dark]") > name.lastIndexOf("[light]") ? "dark" : "light";
  }
  window.obsstudio?.getCurrentScene?.(applyScene);
  window.addEventListener("obsSceneChanged", event => applyScene(event.detail));
})();
