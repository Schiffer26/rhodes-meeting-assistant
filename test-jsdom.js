import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve('./dist/index.html'), 'utf8');

import jsdom from 'jsdom';
const virtualConsole = new jsdom.VirtualConsole();
virtualConsole.on("error", (e) => { console.log("JSDOM ERROR:", e); });
virtualConsole.on("warn", (e) => { console.log("JSDOM WARN:", e); });
virtualConsole.on("info", (e) => { console.log("JSDOM INFO:", e); });
virtualConsole.on("log", (e) => { console.log("JSDOM LOG:", e); });

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  resources: "usable",
  virtualConsole
});

dom.window.addEventListener('error', (event) => {
  console.log("DOM ERROR:", event.error || event.message);
});

dom.window.addEventListener('unhandledrejection', (event) => {
  console.log("DOM UNHANDLED REJECTION:", event.reason);
});

dom.window.addEventListener('load', () => {
  setTimeout(() => {
    const root = dom.window.document.getElementById('root');
    console.log("ROOT HTML:", root.innerHTML.substring(0, 500));
    console.log("BODY HTML length:", dom.window.document.body.innerHTML.length);
  }, 1000);
});
