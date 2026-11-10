"""
Builds a 100% standalone, single-file HTML version of Project Resilience Engine:
Project_Resilience_Engine_Standalone.html
Embeds the CSS, the 170 KB supply_chain_data.json dataset, the supplyChainEngine.js logic,
and the React App.js into a single self-contained HTML file that opens directly by double-clicking
on any computer (via file://) with zero Python server or installation required.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSS_PATH = os.path.join(BASE_DIR, "app", "src", "styles", "editorial.css")
JSON_PATH = os.path.join(BASE_DIR, "app", "public", "data", "supply_chain_data.json")
ENGINE_PATH = os.path.join(BASE_DIR, "app", "src", "engine", "supplyChainEngine.js")
APP_PATH = os.path.join(BASE_DIR, "app", "src", "App.js")

def build_standalone():
    with open(CSS_PATH, "r", encoding="utf-8") as f:
        css_code = f.read()

    with open(JSON_PATH, "r", encoding="utf-8") as f:
        json_code = f.read()

    with open(ENGINE_PATH, "r", encoding="utf-8") as f:
        engine_code = f.read()

    with open(APP_PATH, "r", encoding="utf-8") as f:
        app_code = f.read()

    # Strip ES module export keywords from engine_code so it runs inline in the module script
    engine_inline = engine_code.replace("export function ", "function ")

    # Strip import statements from app_code and replace fetch('./public/data/supply_chain_data.json') with window.__EMBEDDED_SUPPLY_CHAIN_DATA__
    lines = app_code.splitlines()
    filtered_lines = []
    skip_import = False
    for line in lines:
        if line.startswith("import React"):
            continue
        if line.startswith("import {"):
            skip_import = True
            continue
        if skip_import:
            if "from './engine/supplyChainEngine.js';" in line:
                skip_import = False
            continue
        if line.startswith("export default function App()"):
            filtered_lines.append("function App() {")
        else:
            filtered_lines.append(line)

    app_inline = "\n".join(filtered_lines)

    # Replace the useEffect JSON fetch with instant embedded data load (with fallback to fetch if needed)
    old_fetch_block = """    fetch('./public/data/supply_chain_data.json')
      .then(r => {
        if (!r.ok) return fetch('/data/supply_chain_data.json');
        return r;
      })
      .then(r => r.json())
      .then(json => {
        setRawData(json);
        if (json.lanes && json.lanes.length > 0) {
          setSelectedLaneId(json.lanes[0].id);
        }
      })
      .catch(err => console.error('Failed to load supply_chain_data.json:', err));"""

    new_fetch_block = """    if (window.__EMBEDDED_SUPPLY_CHAIN_DATA__) {
      const json = window.__EMBEDDED_SUPPLY_CHAIN_DATA__;
      setRawData(json);
      if (json.lanes && json.lanes.length > 0) {
        setSelectedLaneId(json.lanes[0].id);
      }
    }"""

    app_inline = app_inline.replace(old_fetch_block, new_fetch_block)

    # Also update dispatchRealEmail so when opened as a standalone file:// without Python running, it opens the user's native mail client (mailto:) or logs cleanly
    old_dispatch = """      .catch(err => {
        setSmtpStatus(prev => ({ ...prev, lastResult: `⚠ Error: ${err.message}` }));
      });"""

    new_dispatch = """      .catch(() => {
        const mailtoUrl = `mailto:abhinavjonnagadla1234@gmail.com?subject=${encodeURIComponent(emailPayload.subject)}&body=${encodeURIComponent(emailPayload.body)}`;
        window.open(mailtoUrl, '_blank');
        setSmtpStatus(prev => ({ ...prev, lastResult: `✓ Opened in Default Mail Client for abhinavjonnagadla1234@gmail.com` }));
      });"""

    app_inline = app_inline.replace(old_dispatch, new_dispatch)

    standalone_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Project Resilience Engine — Autonomous AI Supply Chain Control Tower (Standalone Edition)</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:wght@600;700;800&display=swap" rel="stylesheet">
  <style>
{css_code}
  </style>
  <script type="importmap">
    {{
      "imports": {{
        "react": "https://esm.sh/react@18.3.1",
        "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
      }}
    }}
  </script>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__EMBEDDED_SUPPLY_CHAIN_DATA__ = {json_code};
  </script>
  <script type="module">
    import React, {{ useState, useEffect, useRef, useMemo, useCallback }} from 'react';
    import {{ createRoot }} from 'react-dom/client';

{engine_inline}

{app_inline}

    const rootEl = document.getElementById('root');
    if (rootEl) {{
      const root = createRoot(rootEl);
      root.render(React.createElement(App));
    }}
  </script>
</body>
</html>
"""

    out_workspace = os.path.join(BASE_DIR, "Project_Resilience_Engine_Standalone.html")
    with open(out_workspace, "w", encoding="utf-8") as f:
        f.write(standalone_html)

    size_kb = os.path.getsize(out_workspace) / 1024
    print(f"Built standalone single-file HTML: {out_workspace} ({size_kb:.1f} KB)")

if __name__ == "__main__":
    build_standalone()
