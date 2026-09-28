/**
 * CSV Builder Utility
 *
 * Converts an array of objects into a properly formatted CSV string.
 * Handles fields with commas, quotes, and newlines via RFC 4180 escaping.
 */

/**
 * Escape a single CSV field value per RFC 4180.
 */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from an array of objects.
 * Uses the keys of the first object as the header row.
 *
 * @param {object[]} rows - Array of data objects
 * @returns {string} Formatted CSV string
 */
function buildCSV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';

  rows = rows.map((row, index) => ({ 'No.': index + 1, ...row }));
  const headers = Object.keys(rows[0]);
  const headerLine = headers.map(escapeCsvField).join(',');
  const dataLines = rows.map((row) =>
    headers.map((key) => escapeCsvField(row[key])).join(',')
  );

  return [headerLine, ...dataLines].join('\r\n');
}

module.exports = { buildCSV };
