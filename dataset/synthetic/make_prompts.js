// Builds prompts.json: 150 trail-camera image prompts for the wildlife classifier.
// Run: node make_prompts.js
const fs = require('fs');
const path = require('path');

let seed = 20261114;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Lighting split 40% day / 20% dusk / 40% night, assigned in shuffled order per class.
function lightings(n) {
  const d = Math.round(n * 0.4), k = Math.round(n * 0.2);
  return shuffle([...Array(d).fill('day'), ...Array(k).fill('dusk'), ...Array(n - d - k).fill('night')]);
}

const LIGHT = {
  day: () => pick(['Daylight, overcast sky, flat natural colours', 'Daylight, low sun with long shadows, natural colours', 'Daylight, grey dull light, natural colours']),
  dusk: () => pick(['Dusk, low light, muted colours, grainy and soft', 'Dawn, dim bluish light, muted colours, grainy and soft']),
  night: () => 'Night, black-and-white infrared trail-camera image, harsh IR flash lighting the foreground and falling off into black behind',
};
const SCENES = [
  'dense spruce forest edge with undergrowth',
  'mixed pine and birch forest edge',
  'a shallow roadside ditch in the foreground with the forest behind it',
  'the edge of a field with spruce and birch forest behind',
  'a narrow forest path leading into spruce forest',
  'a small clearing in pine forest',
  'a thicket of young birches and low bushes',
  'fallen trees and stumps at the forest edge',
  'tall grass and ferns in front of spruce trees',
];
const VERGE = ['', '', '', ' A strip of grassy road verge is visible along the bottom edge.', ' A strip of road verge is visible along the bottom edge.'];
const WEATHER = {
  winter: ['', '', 'Falling snow.', 'Light fog.', 'Wind-blown snowy branches, slight motion blur.', 'Heavy falling snow.'],
  summer: ['', '', 'Rain, wet leaves.', 'Light fog.', 'Wind-blown branches, slight motion blur.', 'Drizzle and mist.'],
  autumn: ['', '', 'Rain, wet leaves.', 'Morning fog.', 'Wind-blown branches, slight motion blur.', 'Yellow birch leaves on the ground.'],
};
const SEASON = {
  winter: () => 'Winter, snow on the ground and on the trees' + pick(['', '', '. A plowed snow bank along the bottom edge']),
  summer: () => 'Summer, green leaves and undergrowth',
  autumn: () => 'Autumn, yellow birch leaves and brown undergrowth',
};
const seasonFor = (i) => (i % 2 === 0 ? 'winter' : (i % 4 === 1 ? 'summer' : 'autumn'));

const STYLE = 'Camera-trap look, not a nice wildlife photo: slightly low quality, some blur, sensor noise, JPEG compression, slightly wide-angle lens. ' +
  'The road surface is not visible. The image is the view seen THROUGH the camera: do not show any camera, trail camera box or device anywhere in the image. No text, no timestamps, no date overlay, no watermark, no logo, no border.';

function prompt({ light, season, scene, weather, subject }) {
  return `Generate an image (square 1:1). A still frame from a fixed trail camera mounted about 2 m high at the edge of a road in Finland, pointing into the forest beside the road. ` +
    `${LIGHT[light]()}. ${SEASON[season]()}. Scene: ${scene}.${pick(VERGE)} ${weather} Subject: ${subject} ${STYLE}`.replace(/\s+/g, ' ').trim();
}

const out = [];
function addClass(cls, items) {
  const L = lightings(items.length);
  shuffle(items).forEach((it, i) => {
    const light = it.light || L[i];
    const season = it.season || seasonFor(i + (cls.length));
    const subject = typeof it.subject === 'function' ? it.subject({ light, season }) : it.subject;
    const n = String(i + 1).padStart(3, '0');
    out.push({
      file: `${cls}/${cls}_${it.name}_${light}_${n}.jpg`,
      cls, subjectName: it.name, light, season,
      prompt: prompt({ light, season, scene: it.scene || pick(SCENES), weather: pick(WEATHER[season]), subject }),
    });
  });
}
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// ---------- no_animal (70) ----------
const NO = 'There are NO animals and no birds anywhere in the image.';
const noAnimal = [
  ...rep(45, () => ({ name: 'emptyforest', subject: () => `nothing, an empty forest view. ${NO} No people.` })),
  ...rep(15, (i) => {
    const p = [
      { name: 'hiker', subject: 'a hiker with a backpack walking among the trees, partly turned away.' },
      { name: 'jogger', subject: 'a jogger running along the forest edge, slightly motion blurred.' },
      { name: 'berrypicker', season: i % 2 ? 'summer' : 'autumn', subject: 'a person crouching and picking berries with a bucket among the undergrowth.' },
      { name: 'hunter', subject: 'a hunter in a blaze-orange vest and cap standing among the trees.' },
      { name: 'skier', season: 'winter', subject: 'a cross-country skier gliding along a ski track among the trees.' },
      { name: 'flashlight', light: 'night', subject: 'a person walking at night holding a bright flashlight, the beam flaring in the camera.' },
    ][i % 6];
    const dist = pick(['close to the camera', 'at medium distance', 'far away and small', 'partly hidden behind a tree trunk']);
    return { ...p, subject: `${p.subject} The person is ${dist}. ${NO}` };
  }),
  ...rep(10, (i) => [
    { name: 'headlightglare', light: 'night', subject: `bright car headlight glare entering from the side of the frame, lens flare and blown-out highlights across the trees. ${NO} No people.` },
    { name: 'passingcar', subject: `the front or rear of a passing car only partly visible at the very edge of the frame, motion blurred. ${NO} No people.` },
    { name: 'signpost', subject: `a roadside reflective marker post or a road sign post seen from behind, its reflector glowing brightly. ${NO} No people.` },
  ][i % 3]),
];
addClass('no_animal', noAnimal);

// ---------- warn_animal (50) ----------
const ANIMALS_WARN = {
  whitetaileddeer: { n: 18, desc: ({ season }) => `white-tailed deer${season === 'winter' ? ' in greyish-brown winter coat' : ' in reddish-brown coat'}, white underside of the tail`, plural: 'white-tailed deer' },
  roedeer: { n: 15, desc: ({ season }) => `roe deer, small and slender, ${season === 'winter' ? 'grey-brown winter coat' : 'reddish-brown summer coat'} with a white rump patch`, plural: 'roe deer' },
  moose: { n: 12, desc: () => 'moose (Eurasian elk), very large, dark brown, long legs', plural: 'moose' },
  wildboar: { n: 5, desc: () => 'wild boar, dark bristly coat', plural: 'wild boars' },
};
const warn = [];
for (const [name, a] of Object.entries(ANIMALS_WARN)) {
  for (let i = 0; i < a.n; i++) {
    const variant = ['single', 'single', 'group', 'hidden', 'single', 'eyes'][i % 6];
    warn.push({
      name, light: variant === 'eyes' ? 'night' : undefined,
      subject: ({ light, season }) => {
        const d = a.desc({ season });
        const dist = pick(['close to the camera, but cut off by the image edge', 'at medium distance', 'far away and small in the frame', 'far away and small in the frame', 'at medium distance, off-centre']);
        if (variant === 'group') return `${2 + Math.floor(rnd() * 2)} ${a.plural} (${d}) among the trees, ${dist}.`;
        if (variant === 'hidden') return `one ${d}, partly hidden behind tree trunks and branches, ${dist}.`;
        if (variant === 'eyes' && light === 'night') return `${pick(['one', 'two'])} ${a.plural} in the dark, mostly only glowing eyeshine and a faint body outline visible, ${pick(['at medium distance', 'far away'])}.`;
        return `one ${d}, ${dist}.`;
      },
    });
  }
}
addClass('warn_animal', warn);

// ---------- small_animal (30) ----------
const SMALL = {
  redfox: { n: 12, desc: () => 'a red fox' },
  hare: { n: 10, desc: ({ season }) => season === 'winter' ? 'a mountain hare in white winter coat' : 'a brown hare in summer coat' },
  badger: { n: 8, desc: () => 'a European badger with black and white striped face', season: 'summer' },
};
const small = [];
for (const [name, a] of Object.entries(SMALL)) {
  for (let i = 0; i < a.n; i++) {
    small.push({
      name, season: name === 'badger' ? (i % 2 ? 'summer' : 'autumn') : undefined,
      subject: ({ light, season }) => `${a.desc({ season })}, only one animal, ${pick(['close to the camera', 'at medium distance', 'far away and small', 'partly hidden in undergrowth', 'near the image edge'])}${light === 'night' ? ', eyes glowing in the IR light' : ''}.`,
    });
  }
}
addClass('small_animal', small);

fs.writeFileSync(path.join(__dirname, 'prompts.json'), JSON.stringify(out, null, 1));
const count = {};
out.forEach((o) => { const k = `${o.cls}/${o.light}`; count[k] = (count[k] || 0) + 1; });
console.log(out.length, count);
