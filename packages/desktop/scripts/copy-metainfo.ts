import { resolveChannel } from "./utils";

const arg = process.argv[2];
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel();

const appId = channel === "prod" ? "sh.omp.desktop" : `sh.omp.desktop.${channel}`;
const productName = channel === "prod" ? "OMP" : `OMP ${channel.charAt(0).toUpperCase() + channel.slice(1)}`;
const summary = `OMP coding agent desktop${channel !== "prod" ? ` (${channel})` : ""}`;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="sh.omp">
    <name>OMP contributors</name>
  </developer>

  <description>
    <p>
      OMP is an open source coding agent with a terminal, web, and desktop interface.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/can1357/oh-my-pi/issues</url>
  <url type="homepage">https://omp.sh</url>
  <url type="vcs-browser">https://github.com/can1357/oh-my-pi</url>

</component>
`;

await Bun.write(`resources/${appId}.metainfo.xml`, xml);
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`);
