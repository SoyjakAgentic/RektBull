/**
 * RektBull's bull: the logo mark and its meme faces, drawn as SVG.
 *
 * The head is the shield (the site's original mark), with horns on top and
 * the snout and nose ring at its point. One character, many moods: the calm
 * face is the logo; the others are reaction images for posts and the site.
 *
 *   node brand/bull.js      writes public/brand/*.svg
 *
 * Everything is drawn on a 128-unit grid. `mark()` is the simplified version
 * for small sizes (favicons, the header), on a 32-unit grid.
 */
const fs = require('fs');
const path = require('path');

const C = {
  ink: '#0d1424', // outlines
  head: '#2346d6', // the brand's blue
  headShade: '#1b37ad',
  snout: '#6a88f5',
  horn: '#fff4dd',
  hornShade: '#e9d9b8',
  eye: '#ffffff',
  ring: '#f5b700',
  sweat: '#8fd3ff',
  steam: '#dfe6f5',
  shades: '#0d1424',
  bad: '#c42f3a',
};

// The head: the shield, scaled to the 128 grid.
const HEAD = 'M64 18 L106 33 V64 C106 89 88.5 108 64 116 C39.5 108 22 89 22 64 V33 Z';
// The horns: crescents rising from the head's top corners.
const HORN_L = 'M28 38 C14 34 5 22 9 6 C15 18 25 24 40 27 Z';
const HORN_R = 'M100 38 C114 34 123 22 119 6 C113 18 103 24 88 27 Z';
// A horn snapped off at the tip, for the rekt face.
const HORN_R_BROKEN = 'M100 38 C112 35 118 29 119 22 L113 19 L116 15 C111 21 102 25 88 27 Z';
const OUT = 4.5;

const eyes = {
  calm: () => `
    <ellipse cx="47" cy="60" rx="10" ry="11" fill="${C.eye}" stroke="${C.ink}" stroke-width="3.5"/>
    <ellipse cx="81" cy="60" rx="10" ry="11" fill="${C.eye}" stroke="${C.ink}" stroke-width="3.5"/>
    <circle cx="49" cy="62" r="5" fill="${C.ink}"/><circle cx="83" cy="62" r="5" fill="${C.ink}"/>
    <circle cx="51" cy="60" r="1.6" fill="#fff"/><circle cx="85" cy="60" r="1.6" fill="#fff"/>
    <path d="M37 46 L56 49 M91 46 L72 49" stroke="${C.ink}" stroke-width="4.5" stroke-linecap="round"/>`,
  rekt: () => `
    <path d="M40 53 L54 67 M54 53 L40 67 M74 53 L88 67 M88 53 L74 67" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>`,
  sweating: () => `
    <ellipse cx="47" cy="61" rx="10" ry="10" fill="${C.eye}" stroke="${C.ink}" stroke-width="3.5"/>
    <ellipse cx="81" cy="61" rx="10" ry="10" fill="${C.eye}" stroke="${C.ink}" stroke-width="3.5"/>
    <circle cx="52" cy="63" r="4.5" fill="${C.ink}"/><circle cx="86" cy="63" r="4.5" fill="${C.ink}"/>
    <path d="M37 52 L56 45 M91 52 L72 45" stroke="${C.ink}" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M102 40 C99 47 96 51 96 55 A6 6 0 0 0 108 55 C108 51 105 47 102 40 Z" fill="${C.sweat}" stroke="${C.ink}" stroke-width="3"/>`,
  shook: () => `
    <circle cx="46" cy="58" r="13.5" fill="${C.eye}" stroke="${C.ink}" stroke-width="3.5"/>
    <circle cx="82" cy="58" r="13.5" fill="${C.eye}" stroke="${C.ink}" stroke-width="3.5"/>
    <circle cx="46" cy="58" r="3" fill="${C.ink}"/><circle cx="82" cy="58" r="3" fill="${C.ink}"/>
    <path d="M34 40 L52 38 M94 40 L76 38" stroke="${C.ink}" stroke-width="4.5" stroke-linecap="round"/>`,
  steaming: () => `
    <path d="M37 56 Q47 64 57 56 M71 56 Q81 64 91 56" fill="none" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>
    <path d="M36 44 L57 52 M92 44 L71 52" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>`,
  shades: () => `
    <path d="M30 52 H98 V58 C98 68 90 72 82 72 C74 72 69 66 68 58 H60 C59 66 54 72 46 72 C38 72 30 68 30 58 Z" fill="${C.shades}" stroke="${C.ink}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M36 57 L44 57 M74 57 L82 57" stroke="#5f7bff" stroke-width="3" stroke-linecap="round"/>`,
};

const mouths = {
  calm: () => '',
  rekt: () => `<path d="M58 104 Q62 112 66 104" fill="#f08a96" stroke="${C.ink}" stroke-width="3"/>`,
  sweating: () => '',
  shook: () => `<ellipse cx="64" cy="106" rx="5" ry="6" fill="${C.ink}"/>`,
  steaming: () => `
    <g fill="${C.steam}" stroke="${C.ink}" stroke-width="3">
      <circle cx="30" cy="108" r="7"/><circle cx="20" cy="114" r="5.5"/><circle cx="11" cy="118" r="4"/>
      <circle cx="98" cy="108" r="7"/><circle cx="108" cy="114" r="5.5"/><circle cx="117" cy="118" r="4"/>
    </g>`,
  shades: () => '',
};

/** The full bull, on a 128 grid, in a mood. */
function bull(mood = 'calm', { size = 128, background = null, sticker = false } = {}) {
  const hornR = mood === 'rekt' ? HORN_R_BROKEN : HORN_R;
  const border = sticker ? `<g fill="#fff" stroke="#fff" stroke-width="13" stroke-linejoin="round"><path d="${HORN_L}"/><path d="${hornR}"/><path d="${HEAD}"/>${mood === 'steaming' ? '<circle cx="30" cy="108" r="7"/><circle cx="20" cy="114" r="5.5"/><circle cx="11" cy="118" r="4"/><circle cx="98" cy="108" r="7"/><circle cx="108" cy="114" r="5.5"/><circle cx="117" cy="118" r="4"/>' : ''}${mood === 'sweating' ? '<path d="M102 40 C99 47 96 51 96 55 A6 6 0 0 0 108 55 C108 51 105 47 102 40 Z"/>' : ''}</g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${sticker ? '-6 -6 140 140' : '0 0 128 128'}" width="${size}" height="${size}" role="img" aria-label="RektBull's bull, ${mood}">
  ${background ? `<rect x="-6" y="-6" width="140" height="140" fill="${background}"/>` : ''}
  ${border}
  <defs><clipPath id="h"><path d="${HEAD}"/></clipPath></defs>
  <path d="${HORN_L}" fill="${C.horn}" stroke="${C.ink}" stroke-width="${OUT}" stroke-linejoin="round"/>
  <path d="${hornR}" fill="${C.horn}" stroke="${C.ink}" stroke-width="${OUT}" stroke-linejoin="round"/>
  <path d="${HEAD}" fill="${C.head}"/>
  <g clip-path="url(#h)">
    <path d="M22 33 L64 18 L64 116 C39.5 108 22 89 22 64 Z" fill="${C.headShade}" opacity=".35"/>
    <ellipse cx="64" cy="96" rx="30" ry="20" fill="${C.snout}"/>
  </g>
  <path d="${HEAD}" fill="none" stroke="${C.ink}" stroke-width="${OUT}" stroke-linejoin="round"/>
  <ellipse cx="54" cy="93" rx="4" ry="5.5" fill="${C.ink}"/>
  <ellipse cx="74" cy="93" rx="4" ry="5.5" fill="${C.ink}"/>
  ${mood === 'shook' || mood === 'rekt' ? '' : `<path d="M55 99 C55 111 73 111 73 99" fill="none" stroke="${C.ring}" stroke-width="4.5" stroke-linecap="round"/>`}
  ${eyes[mood]()}
  ${mouths[mood]()}
</svg>`;
}

/**
 * The mark for small sizes (favicon, header): the head, horns and eyes, no
 * snout detail or outlines thinner than a pixel at 16 px.
 */
function mark({ size = 32, head = C.head, snout = C.snout, horn = C.horn, ink = C.ink, id = 'm', decorative = false } = {}) {
  const shield = 'M16 4.5 L26.5 8.2 V16 C26.5 22.3 22.1 27 16 29 C9.9 27 5.5 22.3 5.5 16 V8.2 Z';
  const a11y = decorative ? 'aria-hidden="true"' : 'role="img" aria-label="RektBull"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${size ? ` width="${size}" height="${size}"` : ''} ${a11y}>
  <defs><clipPath id="${id}"><path d="${shield}"/></clipPath></defs>
  <path d="M7.2 9.6 C3.6 8.7 1.2 5.6 2.1 1.4 C3.7 4.4 6.3 6 10.2 6.8 Z" fill="${horn}" stroke="${ink}" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M24.8 9.6 C28.4 8.7 30.8 5.6 29.9 1.4 C28.3 4.4 25.7 6 21.8 6.8 Z" fill="${horn}" stroke="${ink}" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="${shield}" fill="${head}"/>
  <ellipse cx="16" cy="24" rx="7.6" ry="5.4" fill="${snout}" clip-path="url(#${id})"/>
  <path d="${shield}" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linejoin="round"/>
  <circle cx="12" cy="14.6" r="2.7" fill="#fff"/><circle cx="20" cy="14.6" r="2.7" fill="#fff"/>
  <circle cx="12.5" cy="15.1" r="1.4" fill="${ink}"/><circle cx="20.5" cy="15.1" r="1.4" fill="${ink}"/>
  <path d="M13.6 25.4 C13.6 28.6 18.4 28.6 18.4 25.4" fill="none" stroke="${C.ring}" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;
}

const MOODS = Object.keys(eyes);

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'public', 'brand');
  fs.mkdirSync(dir, { recursive: true });
  for (const m of MOODS) fs.writeFileSync(path.join(dir, `bull-${m}.svg`), bull(m));
  fs.writeFileSync(path.join(dir, 'mark.svg'), mark());
  console.log('wrote', MOODS.map(m => `bull-${m}.svg`).concat('mark.svg').join(', '));
}

module.exports = { bull, mark, MOODS, C };
