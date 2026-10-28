// BACKUP COPY (build_backups.py): there is no unlock server here. API_BASE is a data: URL that never
// parses as JSON, so the state check fails at once and UNLOCK_ALL_WHEN_OFFLINE opens every challenge.
// CTF Practice · site configuration (edit this file, nothing else needs to change)
window.CTF_CONFIG = {
  // Where the unlock-state API lives. Same origin by default: GET/POST {API_BASE}/state
  // If the API is hosted elsewhere, use a full URL, e.g. "https://ctf-api.flippedbyneel.com".
  API_BASE: "data:,offline",
  // How often the challenge grid re-checks the unlock state (milliseconds).
  POLL_MS: 8000,
  // If the API is unreachable (local file preview, dev), treat every challenge as unlocked?
  UNLOCK_ALL_WHEN_OFFLINE: true,
  // Shown in the page header.
  CLUB_NAME: "Stratford Cybersecurity Club · weeks 8 and 9"
};
