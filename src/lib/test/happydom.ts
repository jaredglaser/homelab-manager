// Import React first to ensure internals are initialized before Happy-DOM
import "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  // eslint-disable-next-line no-var
  var BASE_UI_ANIMATIONS_DISABLED: boolean;
}

GlobalRegistrator.register();

// Happy-DOM 20.12 added Element.getAnimations(), which routes Base UI's Popover/Dialog
// unmount through a real animation-finished wait that Happy-DOM never settles, so
// closed popups stay mounted. This is Base UI's documented flag for headless tests.
globalThis.BASE_UI_ANIMATIONS_DISABLED = true;