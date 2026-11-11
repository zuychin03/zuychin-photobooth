export const THEME_STORAGE_KEY = "zuychin-theme";

/** Runs in <head> before paint. Only an explicit choice is stored; without one the media query decides. */
export const themeBootScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.classList.add(t)}catch(e){}})()`;
