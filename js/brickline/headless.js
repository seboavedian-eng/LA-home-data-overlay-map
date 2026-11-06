// Loaded before js/blockgroups.js: the explorer's script then supplies
// BG_CONFIG and its lookup engine without building its own map into this
// page. A file rather than an inline <script>, so the public server's
// Content-Security-Policy can allow scripts from this site only.
window.BLOCKGROUPS_HEADLESS = true;
