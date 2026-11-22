// Finansijski izvještaj kao Word (.docx), da ga Škola može dopuniti i ubaciti u svoj godišnji izvještaj.
const fs = require('node:fs');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, Table, TableRow, TableCell, WidthType,
  BorderStyle, ShadingType, TabStopType,
} = require('docx');

const FONT = 'Calibri';
const SIZE = 23; // 11,5 pt (u pola tačke)

// "**podebljano** obično" -> TextRun-ovi
function runs(text, opts = {}) {
  return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => new TextRun({
    text: part.startsWith('**') ? part.slice(2, -2) : part,
    bold: part.startsWith('**') || opts.bold,
    italics: opts.italics,
    size: opts.size || SIZE,
    color: opts.color,
    font: FONT,
  }));
}

const para = (text, o = {}) => new Paragraph({
  children: runs(text, o), alignment: o.align, spacing: { after: o.after ?? 120, before: o.before ?? 0, line: 300 }, indent: o.indent,
});

const border = { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text, { bold = false, align = 'l', shade = false, width } = {}) {
  return new TableCell({
    borders,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: shade ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F2F2' } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: [new Paragraph({
      children: runs(text, { bold, size: 20 }),
      alignment: align === 'r' ? AlignmentType.RIGHT : AlignmentType.LEFT,
    })],
  });
}

function block(b) {
  switch (b.type) {
    case 'h':
      return [para(b.text, { bold: true, size: 26, before: 240, after: 120 })];
    case 'p':
      return [para(b.text, { align: AlignmentType.JUSTIFIED })];
    case 'note':
      return [para(b.text, { italics: true, size: 19, color: '666666', before: 60 })];
    case 'list':
      return b.items.map((i) => para(`-  ${i}`, { indent: { left: 360 }, after: 40 }));
    case 'group':
      return [
        para(`•  **${b.title}**`, { before: 120, after: 60 }),
        ...b.items.map((i) => para(`-  ${i}`, { indent: { left: 540 }, after: 30 })),
        para(`**${b.total}**`, { indent: { left: 360 }, before: 60, after: 120 }),
      ];
    case 'summary':
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: b.items.map((i) => cell(i.label, { shade: true, width: 25 })) }),
          new TableRow({ children: b.items.map((i) => cell(`**${i.value}**${i.note ? `  (${i.note})` : ''}`, { width: 25 })) }),
        ],
      }), para('', { after: 60 })];
    case 'table':
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: b.head.map((x, i) => cell(x, { bold: true, shade: true, align: b.align[i] })) }),
          ...b.rows.map((r) => new TableRow({ children: r.map((x, i) => cell(x, { align: b.align[i] })) })),
          new TableRow({ children: b.foot.map((x, i) => cell(x, { bold: true, shade: true, align: b.align[i] })) }),
        ],
      }), para('', { after: 60 })];
    default:
      return [];
  }
}

async function renderDocx(doc) {
  const logoFile = path.join(__dirname, '..', 'public', 'brand', 'logo-600.png');
  const header = [];
  if (fs.existsSync(logoFile)) {
    header.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({ type: 'png', data: fs.readFileSync(logoFile), transformation: { width: 88, height: 72 } })],
    }));
  }
  header.push(para(doc.school, { bold: true, size: 30, align: AlignmentType.CENTER, after: 60 }));
  header.push(para(doc.title, { size: 26, align: AlignmentType.CENTER, after: doc.subtitle ? 40 : 240 }));
  if (doc.subtitle) header.push(para(doc.subtitle, { size: 22, color: '555555', align: AlignmentType.CENTER, after: 240 }));

  const signer = `Izvještaj uradio${doc.signer.includes(':') ? ' ' : ': '}${doc.signer}`;
  const closing = new Paragraph({
    spacing: { before: 600 },
    tabStops: [{ type: TabStopType.RIGHT, position: 9600 }],
    children: [...runs(`U ${doc.place}: ${doc.date} god.`), new TextRun({ text: '\t', font: FONT }), ...runs(signer)],
  });

  const document = new Document({
    creator: doc.signer,
    title: doc.title,
    styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      children: [...header, ...doc.blocks.flatMap(block), closing],
    }],
  });
  return Packer.toBuffer(document);
}

module.exports = { renderDocx };
