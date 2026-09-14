const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

const { typedCellValue, fillXlsxPlaceholders } = require('../lib/docgen');

test('typedCellValue: numeric strings become real numbers', () => {
	assert.strictEqual(typedCellValue('150000'), 150000);
	assert.strictEqual(typedCellValue('-12.5'), -12.5);
	assert.strictEqual(typedCellValue('0'), 0);
});

test('typedCellValue: a leading "=" becomes an ExcelJS formula cell, not text', () => {
	assert.deepStrictEqual(typedCellValue('=SUM(A1:A9)'), { formula: 'SUM(A1:A9)' });
});

test('typedCellValue: ordinary text and already-typed values pass through unchanged', () => {
	assert.strictEqual(typedCellValue('Makan siang'), 'Makan siang');
	assert.strictEqual(typedCellValue(''), '');
	assert.strictEqual(typedCellValue(42), 42); // already a number from JSON — not a string
	assert.strictEqual(typedCellValue(null), null);
});

test('fillXlsxPlaceholders replaces {tag} in template cells and leaves other cells alone', () => {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Sheet1');
	sheet.getCell('A1').value = 'Judul: {title}';
	sheet.getCell('A2').value = 'Tanggal: {date}';
	sheet.getCell('A3').value = 'No matching tag: {unknown}';
	sheet.getCell('A4').value = 'Plain text, no braces';
	sheet.getCell('A5').value = 42; // non-string — must not throw

	fillXlsxPlaceholders(workbook, { title: 'Laporan Bulanan', date: '14 September 2026' });

	assert.strictEqual(sheet.getCell('A1').value, 'Judul: Laporan Bulanan');
	assert.strictEqual(sheet.getCell('A2').value, 'Tanggal: 14 September 2026');
	assert.strictEqual(sheet.getCell('A3').value, 'No matching tag: {unknown}', 'a tag with no matching data key is left as-is, not blanked');
	assert.strictEqual(sheet.getCell('A4').value, 'Plain text, no braces');
	assert.strictEqual(sheet.getCell('A5').value, 42);
});

test('fillXlsxPlaceholders covers every sheet in the workbook', () => {
	const workbook = new ExcelJS.Workbook();
	const sheet2 = workbook.addWorksheet('First');
	const sheet3 = workbook.addWorksheet('Second');
	sheet2.getCell('A1').value = '{title}';
	sheet3.getCell('B2').value = 'By {title}';

	fillXlsxPlaceholders(workbook, { title: 'X' });

	assert.strictEqual(sheet2.getCell('A1').value, 'X');
	assert.strictEqual(sheet3.getCell('B2').value, 'By X');
});
