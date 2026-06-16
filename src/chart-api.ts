/**
 * Generic chart pipeline for Telegram extensions.
 * Any bot deployed to this fork can call sendChart() with a Vega-Lite spec
 * and get a PNG photo delivered to Telegram. Bot-specific query + spec
 * logic stays in the private bot repo; this module owns render → send.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Resvg } from '@resvg/resvg-js';
import * as vega from 'vega';
import * as vl from 'vega-lite';
import type { TopLevelSpec } from 'vega-lite';

import { log } from './log.js';

// Resvg 2.x doesn't scan /usr/share/fonts via loadSystemFonts on all Linux distros.
// Probe common font dirs and pass them explicitly so text renders in charts.
const FONT_SEARCH_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  `${process.env.HOME ?? ''}/.local/share/fonts`,
  `${process.env.HOME ?? ''}/.fonts`,
];
const fontDirs = FONT_SEARCH_DIRS.filter((d) => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
});

export type { TopLevelSpec };

export async function specToPng(spec: TopLevelSpec): Promise<Buffer> {
  const vgSpec = vl.compile(spec).spec;
  const view = new vega.View(vega.parse(vgSpec), { renderer: 'none' });
  const svg = await view.toSVG();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 800 },
    font: { fontDirs, loadSystemFonts: false, defaultFontFamily: 'Liberation Sans' },
  });
  return Buffer.from(resvg.render().asPng());
}

export async function sendChart(
  token: string,
  platformId: string,
  spec: TopLevelSpec,
  caption?: string,
): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) {
    log.warn('sendChart: could not extract chatId from platformId', { platformId });
    return;
  }

  let png: Buffer;
  try {
    png = await specToPng(spec);
  } catch (err) {
    log.error('sendChart: chart render failed', { err });
    throw err;
  }

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([png], { type: 'image/png' }), 'chart.png');
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram sendPhoto failed: ${res.status} ${body.slice(0, 200)}`);
  }
}
