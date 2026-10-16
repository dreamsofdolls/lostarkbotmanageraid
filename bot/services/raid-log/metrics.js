"use strict";

/**
 * bot/services/raid-log/metrics.js
 * readPartyMetrics: in-page reader for the party figures the /raid-log card
 * shows. It runs inside Bible's page through page.evaluate, so the function
 * is self-contained.
 * Bible's header row has one more cell than its data rows (the name cell
 * spans two columns), so a column is located by colSpan position.
 */

// Runs in the page. One entry per party row of the Damage overview in table
// order. A column Bible no longer prints reads as null.
function readPartyMetrics() {
  const text = node => (node?.textContent || "").trim();
  const number = value => {
    const match = /^(-?[\d,.]+)\s*([kmbt%])?$/i.exec(value);
    if (!match) return null;
    const scale = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(match[2] || "").toLowerCase()] || 1;
    const parsed = Number(match[1].replace(/,/g, "")) * scale;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const columnsOf = table => {
    const columns = new Map();
    let position = 0;
    for (const cell of table.tHead.rows[0].cells) {
      if (text(cell)) columns.set(text(cell), position);
      position += cell.colSpan || 1;
    }
    return columns;
  };
  const cellAt = (row, position) => {
    let start = 0;
    for (const cell of row.cells) {
      const span = cell.colSpan || 1;
      if (position >= start && position < start + span) return cell;
      start += span;
    }
    return null;
  };
  const tables = [...document.querySelectorAll("table")].filter(table => table.tHead && /^Party\s+\d+/.test(text(table.tHead)));
  return tables.flatMap((table, partyIndex) => {
    const columns = columnsOf(table);
    const figure = (row, name) => (columns.has(name) ? number(text(cellAt(row, columns.get(name)))) : null);
    return [...table.tBodies[0].rows].map((row, rowIndex) => ({
      id: `${partyIndex + 1}-${rowIndex}`,
      label: text(row.cells[1]?.querySelector(".truncate")),
      className: row.querySelector('img[src*="/classes/"]')?.alt || "",
      // Badges are the leaf nodes holding only a number; wrappers repeat the text.
      badges: [...(row.cells[1]?.querySelectorAll("*") || [])]
        .filter(node => node.children.length === 0 && /^\d{1,3}$/.test(text(node)))
        .map(node => Number(text(node))),
      dps: figure(row, "DPS"),
      ndps: figure(row, "nDPS"),
      contribution: figure(row, "rCon%"),
      damageShare: figure(row, "D%"),
      stagger: figure(row, "STAG"),
      counters: figure(row, "CTR"),
    }));
  });
}

module.exports = { readPartyMetrics };
