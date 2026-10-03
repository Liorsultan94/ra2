/*
 * Fictional local adverts for the roadside billboards: no real brands. Each
 * nation's language gets six designs (soft drink, phone, coffee, cars, burger,
 * bank) with made-up brand names, local-language slogans, prices in the local
 * currency and phone numbers in the local format (the 555 ranges where they
 * exist). The posters are painted procedurally on a canvas: product shots are
 * drawn from shapes and gradients (no photos, nothing to license).
 */

export type Product = 'drink' | 'phone' | 'coffee' | 'car' | 'burger' | 'bank';

export interface AdCopy {
  brand: string;
  slogan: string;
  price: string;
  phone: string;
}

interface Lang {
  rtl: boolean;
  font: string;
  ads: Record<Product, AdCopy>;
}

const SANS = '"Noto Sans", "DejaVu Sans", "Liberation Sans", Arial, sans-serif';

export const LANGS: Record<string, Lang> = {
  usa: {
    rtl: false,
    font: SANS,
    ads: {
      drink: { brand: 'FIZZWELL', slogan: 'Taste the cold.', price: '$1.99', phone: '1-800-555-0142' },
      phone: { brand: 'NOVA X9', slogan: 'Your world. Faster.', price: '$499', phone: '(555) 014-2233' },
      coffee: { brand: 'Maple Roast', slogan: 'Fresh every morning', price: '$2.49', phone: '(555) 019-7781' },
      car: { brand: 'Brightline Motors', slogan: '0% APR this month', price: 'from $19,990', phone: '(555) 016-4410' },
      burger: { brand: 'Big Ranch Burger', slogan: 'Grilled. Not fried.', price: '$4.99', phone: '(555) 012-0909' },
      bank: { brand: 'Harbor Trust Bank', slogan: 'Home loans made easy', price: '3.9% APR', phone: '1-800-555-0177' },
    },
  },
  israel: {
    rtl: true,
    font: SANS,
    ads: {
      drink: { brand: 'בּוּעָה', slogan: 'הטעם הקר של הקיץ', price: '₪7.90', phone: '03-555-0142' },
      phone: { brand: 'נובה X9', slogan: 'העולם שלך. מהר יותר.', price: '₪1,999', phone: '03-555-2233' },
      coffee: { brand: 'קפה הבוקר', slogan: 'טרי כל בוקר', price: '₪12', phone: '04-555-7781' },
      car: { brand: 'מוטורס הצפון', slogan: '0% ריבית החודש', price: 'החל מ-₪89,900', phone: '09-555-4410' },
      burger: { brand: 'המבורגר הגליל', slogan: 'על הגריל, לא מטוגן', price: '₪39', phone: '02-555-0909' },
      bank: { brand: 'בנק הנמל', slogan: 'משכנתא בקלות', price: '3.9%', phone: '03-555-0177' },
    },
  },
  russia: {
    rtl: false,
    font: SANS,
    ads: {
      drink: { brand: 'МОРОЗКО', slogan: 'Освежает с первого глотка', price: '89 ₽', phone: '+7 (495) 555-01-42' },
      phone: { brand: 'Нова X9', slogan: 'Твой мир. Быстрее.', price: '29 990 ₽', phone: '+7 (495) 555-22-33' },
      coffee: { brand: 'Утренний кофе', slogan: 'Свежий каждое утро', price: '150 ₽', phone: '+7 (812) 555-77-81' },
      car: { brand: 'Автодом', slogan: 'Кредит 0% в этом месяце', price: 'от 1 290 000 ₽', phone: '+7 (495) 555-44-10' },
      burger: { brand: 'Бургер Сибирь', slogan: 'На гриле, а не во фритюре', price: '249 ₽', phone: '+7 (383) 555-09-09' },
      bank: { brand: 'Банк Гавань', slogan: 'Ипотека — это просто', price: '8,9%', phone: '+7 (495) 555-01-77' },
    },
  },
  ukraine: {
    rtl: false,
    font: SANS,
    ads: {
      drink: { brand: 'СВІЖИНКА', slogan: 'Смак прохолоди', price: '25 ₴', phone: '+380 44 555 0142' },
      phone: { brand: 'Нова X9', slogan: 'Твій світ. Швидше.', price: '17 999 ₴', phone: '+380 44 555 2233' },
      coffee: { brand: 'Ранкова кава', slogan: 'Свіжа щоранку', price: '45 ₴', phone: '+380 32 555 7781' },
      car: { brand: 'Автосвіт', slogan: 'Кредит 0% цього місяця', price: 'від 549 000 ₴', phone: '+380 44 555 4410' },
      burger: { brand: 'Бургер Карпати', slogan: 'На грилі, не у фритюрі', price: '129 ₴', phone: '+380 32 555 0909' },
      bank: { brand: 'Банк Гавань', slogan: 'Іпотека — це просто', price: '9,9%', phone: '0 800 555 017' },
    },
  },
  germany: {
    rtl: false,
    font: SANS,
    ads: {
      drink: { brand: 'FROSTQUELL', slogan: 'Kalt. Klar. Köstlich.', price: '1,29 €', phone: '030 5550142' },
      phone: { brand: 'Nova X9', slogan: 'Deine Welt. Schneller.', price: '499 €', phone: '030 5552233' },
      coffee: { brand: 'Morgenröster', slogan: 'Jeden Morgen frisch', price: '2,49 €', phone: '089 5557781' },
      car: { brand: 'Brückner Automobile', slogan: '0 % Finanzierung', price: 'ab 19.990 €', phone: '040 5554410' },
      burger: { brand: 'Grillhaus Burger', slogan: 'Gegrillt, nicht frittiert', price: '5,90 €', phone: '0221 5550909' },
      bank: { brand: 'Hafenbank', slogan: 'Baufinanzierung leicht gemacht', price: '3,9 %', phone: '030 5550177' },
    },
  },
  turkey: {
    rtl: false,
    font: SANS,
    ads: {
      drink: { brand: 'BUZLU', slogan: 'Serinliğin tadı', price: '15 ₺', phone: '0212 555 01 42' },
      phone: { brand: 'Nova X9', slogan: 'Senin dünyan. Daha hızlı.', price: '24.999 ₺', phone: '0212 555 22 33' },
      coffee: { brand: 'Sabah Kahvesi', slogan: 'Her sabah taze', price: '45 ₺', phone: '0312 555 77 81' },
      car: { brand: 'Anadolu Motor', slogan: 'Bu ay %0 faiz', price: "849.000 ₺'den", phone: '0216 555 44 10' },
      burger: { brand: 'Izgara Burger', slogan: 'Kızartma değil, ızgara', price: '120 ₺', phone: '0232 555 09 09' },
      bank: { brand: 'Liman Bankası', slogan: 'Konut kredisi kolay', price: '%2,9', phone: '0850 555 01 77' },
    },
  },
  iran: {
    rtl: true,
    font: SANS,
    ads: {
      drink: { brand: 'یخ‌نوش', slogan: 'طعم خنکی', price: '۱۵٬۰۰۰ تومان', phone: '۰۲۱-۵۵۵۰۱۴۲' },
      phone: { brand: 'نوا X9', slogan: 'دنیای تو، سریع‌تر', price: '۱۲٬۵۰۰٬۰۰۰ تومان', phone: '۰۲۱-۵۵۵۲۲۳۳' },
      coffee: { brand: 'قهوه صبح', slogan: 'هر صبح تازه', price: '۴۵٬۰۰۰ تومان', phone: '۰۳۱-۵۵۵۷۷۸۱' },
      car: { brand: 'خودرو پارس‌نو', slogan: 'اقساط بدون سود', price: 'از ۸۵۰ میلیون', phone: '۰۲۱-۵۵۵۴۴۱۰' },
      burger: { brand: 'برگر البرز', slogan: 'کبابی، نه سرخ‌شده', price: '۱۸۰٬۰۰۰ تومان', phone: '۰۲۶-۵۵۵۰۹۰۹' },
      bank: { brand: 'بانک ساحل', slogan: 'وام مسکن آسان', price: '۱۸٪', phone: '۰۲۱-۵۵۵۰۱۷۷' },
    },
  },
  china: {
    rtl: false,
    font: '"Noto Sans CJK SC", "WenQuanYi Zen Hei", "Microsoft YaHei", "PingFang SC", ' + SANS,
    ads: {
      drink: { brand: '冰泉汽水', slogan: '清凉一夏', price: '¥3.5', phone: '400-555-0142' },
      phone: { brand: '新星 X9', slogan: '你的世界，更快', price: '¥2999', phone: '400-555-2233' },
      coffee: { brand: '晨光咖啡', slogan: '每天早晨新鲜烘焙', price: '¥18', phone: '010-5557781' },
      car: { brand: '远航汽车', slogan: '本月零利率', price: '¥89,800起', phone: '400-555-4410' },
      burger: { brand: '炭烤汉堡', slogan: '炭火烤制，不油炸', price: '¥25', phone: '021-5550909' },
      bank: { brand: '海港银行', slogan: '安家贷款，轻松办理', price: '3.9%', phone: '400-555-0177' },
    },
  },
  korea: {
    rtl: false,
    font: '"Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", "WenQuanYi Zen Hei", ' + SANS,
    ads: {
      drink: { brand: '얼음샘 사이다', slogan: '시원함의 맛', price: '₩1,500', phone: '02-555-0142' },
      phone: { brand: '노바 X9', slogan: '당신의 세상, 더 빠르게', price: '₩999,000', phone: '02-555-2233' },
      coffee: { brand: '아침햇살 커피', slogan: '매일 아침 신선하게', price: '₩3,500', phone: '051-555-7781' },
      car: { brand: '한빛 자동차', slogan: '이번 달 무이자 할부', price: '₩25,900,000부터', phone: '02-555-4410' },
      burger: { brand: '숯불 버거', slogan: '튀기지 않고 구웠습니다', price: '₩6,900', phone: '031-555-0909' },
      bank: { brand: '항구 은행', slogan: '내 집 마련 대출', price: '3.9%', phone: '02-555-0177' },
    },
  },
};

export const PRODUCTS: Product[] = ['drink', 'phone', 'coffee', 'car', 'burger', 'bank'];

/** Brand colours per product: background top / bottom, accent, text. */
const STYLE: Record<Product, [string, string, string, string]> = {
  drink: ['#d81e2a', '#7a0a12', '#ffd23f', '#ffffff'],
  phone: ['#0d1b3d', '#1f4fb8', '#5ef2ff', '#ffffff'],
  coffee: ['#f3e3c8', '#c99a62', '#5a3014', '#3a1e0c'],
  car: ['#e9eef3', '#8fa6bb', '#0d4f9e', '#0b1b2b'],
  burger: ['#ffb000', '#ff6a00', '#d0181b', '#3a1000'],
  bank: ['#0f5e4a', '#06281f', '#e6c35a', '#ffffff'],
};

type Ctx = CanvasRenderingContext2D;

function art(c: Ctx, p: Product, x: number, y: number, s: number, accent: string) {
  c.save();
  c.translate(x, y);
  c.scale(s, s);
  const shine = (x0: number, y0: number, x1: number, y1: number) => {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  };
  // soft shadow under the product
  c.fillStyle = 'rgba(0,0,0,0.28)';
  c.beginPath();
  c.ellipse(0, 92, 70, 12, 0, 0, Math.PI * 2);
  c.fill();
  if (p === 'drink') {
    // a sweating glass bottle
    const g = c.createLinearGradient(-30, 0, 30, 0);
    g.addColorStop(0, '#3d0a0e');
    g.addColorStop(0.45, '#a3121c');
    g.addColorStop(1, '#2a0508');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(-9, -95);
    c.lineTo(9, -95);
    c.lineTo(10, -60);
    c.quadraticCurveTo(32, -40, 32, -10);
    c.lineTo(30, 85);
    c.quadraticCurveTo(0, 95, -30, 85);
    c.lineTo(-32, -10);
    c.quadraticCurveTo(-32, -40, -10, -60);
    c.closePath();
    c.fill();
    c.fillStyle = '#d8d8d8';
    c.fillRect(-11, -104, 22, 12);
    c.fillStyle = accent;
    c.fillRect(-31, 5, 62, 34);
    c.fillStyle = shine(-30, 0, 10, 0);
    c.fillRect(-28, -40, 14, 120);
    c.fillStyle = 'rgba(255,255,255,0.7)';
    for (let k = 0; k < 14; k++) {
      c.beginPath();
      c.arc(-24 + ((k * 37) % 48), -30 + ((k * 53) % 110), 1.6 + (k % 3), 0, Math.PI * 2);
      c.fill();
    }
  } else if (p === 'phone') {
    c.rotate(-0.18);
    c.fillStyle = '#111';
    c.beginPath();
    c.roundRect(-42, -90, 84, 176, 14);
    c.fill();
    const g = c.createLinearGradient(-38, -85, 38, 80);
    g.addColorStop(0, '#5ef2ff');
    g.addColorStop(0.5, '#3a5bff');
    g.addColorStop(1, '#b03aff');
    c.fillStyle = g;
    c.beginPath();
    c.roundRect(-37, -82, 74, 160, 9);
    c.fill();
    c.fillStyle = '#000';
    c.beginPath();
    c.roundRect(-10, -80, 20, 6, 3);
    c.fill();
    c.fillStyle = shine(-40, -90, 40, 0);
    c.fillRect(-37, -82, 74, 80);
  } else if (p === 'coffee') {
    c.fillStyle = '#f7f3ee';
    c.beginPath();
    c.moveTo(-40, -40);
    c.lineTo(40, -40);
    c.lineTo(30, 80);
    c.lineTo(-30, 80);
    c.closePath();
    c.fill();
    c.fillStyle = accent;
    c.fillRect(-38, -10, 74, 40);
    c.fillStyle = '#3a2618';
    c.fillRect(-44, -52, 88, 14);
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = 4;
    for (const dx of [-14, 2, 18]) {
      c.beginPath();
      c.moveTo(dx, -62);
      c.bezierCurveTo(dx - 10, -78, dx + 10, -88, dx, -104);
      c.stroke();
    }
  } else if (p === 'car') {
    const g = c.createLinearGradient(0, -40, 0, 40);
    g.addColorStop(0, '#2f7be0');
    g.addColorStop(1, '#0b2f6e');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(-110, 40);
    c.lineTo(-110, 10);
    c.quadraticCurveTo(-100, -5, -60, -10);
    c.lineTo(-30, -40);
    c.lineTo(40, -40);
    c.lineTo(75, -8);
    c.quadraticCurveTo(110, -2, 112, 20);
    c.lineTo(112, 40);
    c.closePath();
    c.fill();
    c.fillStyle = '#bfe3ff';
    c.beginPath();
    c.moveTo(-24, -34);
    c.lineTo(5, -34);
    c.lineTo(5, -10);
    c.lineTo(-48, -10);
    c.closePath();
    c.moveTo(12, -34);
    c.lineTo(38, -34);
    c.lineTo(62, -10);
    c.lineTo(12, -10);
    c.closePath();
    c.fill();
    for (const wx of [-68, 70]) {
      c.fillStyle = '#111';
      c.beginPath();
      c.arc(wx, 42, 22, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#c8c8c8';
      c.beginPath();
      c.arc(wx, 42, 10, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = shine(-100, -40, -100, 10);
    c.fillRect(-100, -38, 200, 30);
  } else if (p === 'burger') {
    const layer = (y: number, h: number, col: string, r = 14) => {
      c.fillStyle = col;
      c.beginPath();
      c.roundRect(-70, y, 140, h, r);
      c.fill();
    };
    c.fillStyle = '#e09a3a';
    c.beginPath();
    c.ellipse(0, -30, 72, 46, 0, Math.PI, 0);
    c.fill();
    c.fillStyle = '#fff6d8';
    for (let k = 0; k < 9; k++) {
      c.beginPath();
      c.ellipse(-40 + (k % 5) * 20, -52 + Math.floor(k / 5) * 14, 3, 1.6, 0.4, 0, Math.PI * 2);
      c.fill();
    }
    layer(-30, 12, '#3fae2a', 6);
    layer(-20, 10, '#ffcf1a', 4);
    layer(-12, 24, '#5a2a12', 10);
    layer(10, 8, '#d0181b', 4);
    layer(16, 26, '#e09a3a', 12);
  } else {
    // bank: a house and a key
    c.fillStyle = '#f2efe6';
    c.beginPath();
    c.moveTo(-70, -10);
    c.lineTo(0, -70);
    c.lineTo(70, -10);
    c.lineTo(55, -10);
    c.lineTo(55, 70);
    c.lineTo(-55, 70);
    c.lineTo(-55, -10);
    c.closePath();
    c.fill();
    c.fillStyle = '#0f5e4a';
    c.fillRect(-15, 20, 30, 50);
    c.fillStyle = accent;
    c.beginPath();
    c.arc(55, 40, 20, 0, Math.PI * 2);
    c.fill();
    c.fillRect(70, 36, 50, 9);
    c.fillRect(105, 45, 7, 12);
  }
  c.restore();
}

function fit(c: Ctx, text: string, max: number, size: number, weight: string, font: string) {
  let s = size;
  c.font = `${weight} ${s}px ${font}`;
  while (s > 10 && c.measureText(text).width > max) {
    s -= 2;
    c.font = `${weight} ${s}px ${font}`;
  }
  return s;
}

/** Paint one poster into the box (x, y, w, h): w = 2 h. */
export function paintAd(c: Ctx, nation: string, product: Product, x: number, y: number, w: number, h: number) {
  const L = LANGS[nation] ?? LANGS.usa;
  const ad = L.ads[product];
  const [top, bottom, accent, ink] = STYLE[product];
  c.save();
  c.translate(x, y);
  c.scale(w / 512, h / 256);
  c.beginPath();
  c.rect(0, 0, 512, 256);
  c.clip();
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  c.fillStyle = g;
  c.fillRect(0, 0, 512, 256);
  // a diagonal light band and a vignette
  const g2 = c.createLinearGradient(0, 0, 512, 256);
  g2.addColorStop(0, 'rgba(255,255,255,0)');
  g2.addColorStop(0.45, 'rgba(255,255,255,0.12)');
  g2.addColorStop(0.55, 'rgba(255,255,255,0)');
  c.fillStyle = g2;
  c.fillRect(0, 0, 512, 256);
  const rtl = L.rtl;
  const artX = rtl ? 400 : 112;
  art(c, product, artX, 128, 1, accent);
  // text block on the other side
  const tx = rtl ? 300 : 212;
  c.direction = rtl ? 'rtl' : 'ltr';
  c.textAlign = rtl ? 'right' : 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = ink;
  c.shadowColor = 'rgba(0,0,0,0.35)';
  c.shadowBlur = 4;
  const bx = rtl ? tx + 0 : tx;
  const maxW = 285;
  fit(c, ad.brand, maxW, 50, '800', L.font);
  c.fillText(ad.brand, bx, 76);
  fit(c, ad.slogan, maxW, 28, '600', L.font);
  c.fillText(ad.slogan, bx, 118);
  c.shadowBlur = 0;
  // price badge
  const px = rtl ? 72 : 440;
  c.fillStyle = accent;
  c.beginPath();
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const r = k % 2 ? 46 : 54;
    c.lineTo(px + Math.cos(a) * r, 186 + Math.sin(a) * r);
  }
  c.closePath();
  c.fill();
  c.fillStyle = product === 'coffee' || product === 'car' ? '#ffffff' : '#1a1a1a';
  if (product === 'drink' || product === 'burger') c.fillStyle = '#7a0a12';
  c.textAlign = 'center';
  c.direction = rtl ? 'rtl' : 'ltr';
  fit(c, ad.price, 92, 26, '800', L.font);
  c.fillText(ad.price, px, 196);
  // phone line
  c.textAlign = rtl ? 'right' : 'left';
  c.fillStyle = ink;
  c.globalAlpha = 0.85;
  fit(c, '☎ ' + ad.phone, 230, 20, '600', L.font);
  c.direction = 'ltr';
  c.textAlign = rtl ? 'right' : 'left';
  c.fillText(ad.phone, rtl ? 300 : 212, 232);
  c.globalAlpha = 1;
  c.restore();
}

/** Atlas of adverts: two per row (512 x 256 each at full scale). */
export function adAtlas(nations: string[], scale = 1): { canvas: HTMLCanvasElement; cells: number } | null {
  if (typeof document === 'undefined') return null;
  const list: [string, Product][] = [];
  for (const n of nations) for (const p of PRODUCTS) list.push([n, p]);
  const W = Math.round(512 * scale);
  const H = Math.round(256 * scale);
  const rows = Math.ceil(list.length / 2);
  const cv = document.createElement('canvas');
  cv.width = W * 2;
  cv.height = H * rows;
  const c = cv.getContext('2d');
  if (!c) return null;
  list.forEach(([n, p], i) => paintAd(c, n, p, (i % 2) * W, Math.floor(i / 2) * H, W, H));
  return { canvas: cv, cells: list.length };
}
