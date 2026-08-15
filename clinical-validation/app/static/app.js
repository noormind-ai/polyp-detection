/* NoorMind clinical feedback panel.
 *
 * The page deliberately knows very little. It never receives an item's bucket,
 * the model's boxes, or the report text until the server decides it may -- see
 * the blinding rule in app/main.py. Anything sent here is readable in developer
 * tools, so "sent but not displayed" would not be blinding at all.
 */
'use strict';

const API = '/review/api';

/* ------------------------------------------------------------------ i18n */
/* Farsi is the default and lives in the HTML. The English string is the key,
 * carried in data-i18n, so switching languages needs no second dictionary for
 * static text -- the Farsi already on the page is captured at load. */
const FA = {
  'Signing in…': 'در حال ورود…',
  'Saving…': 'در حال ذخیره…',
  'Loading…': 'در حال بارگذاری…',
  'Passwords do not match.': 'گذرواژه‌ها یکسان نیستند.',
  'Something went wrong.': 'خطایی رخ داد.',
  'Session expired. Sign in again.': 'نشست منقضی شد. دوباره وارد شوید.',
  '{done} of {total}': '{done} از {total}',
  'Case {case}': 'مورد {case}',
  'You have an unfinished session: {done} of {total} reviewed.':
    'یک جلسه ناتمام دارید: {done} از {total} بازبینی شده.',
  'You reviewed {n} images. Thank you.': '{n} تصویر بازبینی کردید. سپاسگزاریم.',
  'images': 'تصویر',
  'Reviewer': 'بازبین',
  'Administrator': 'مدیر',
  'Account created': 'حساب ایجاد شد',
  'Give these to the reviewer over a channel you trust. The password is shown once and cannot be recovered.':
    'این اطلاعات را از راهی مطمئن به بازبین بدهید. گذرواژه فقط یک‌بار نمایش داده می‌شود و قابل بازیابی نیست.',
  'New one-time password': 'گذرواژه یک‌بارمصرف جدید',
  'Reset password': 'بازنشانی گذرواژه',
  'Disable': 'غیرفعال کردن',
  'Enable': 'فعال کردن',
  'active': 'فعال',
  'disabled': 'غیرفعال',
  'must change password': 'باید گذرواژه را تغییر دهد',
  'never': 'هرگز',
  'User': 'کاربر',
  'Role': 'نقش',
  'Status': 'وضعیت',
  'Reviewed': 'بازبینی‌شده',
  'Last sign-in': 'آخرین ورود',
  'Actions': 'عملیات',
  'Pool': 'مخزن',
  'Confirmed false positives': 'مثبت کاذب تأییدشده',
  'Possible report misses': 'موارد احتمالی جامانده از گزارش',
  'Reviewed items': 'موارد بازبینی‌شده',
  'Reviewers': 'بازبین‌ها',
  'agreed positives called': 'موارد مثبت توافقی تأییدشده',
  'controls called polyp': 'شاهدهایی که پولیپ اعلام شده',
  'median time': 'زمان میانه',
  'Sessions': 'جلسه‌ها',
  'When': 'زمان',
  'Action': 'رویداد',
  'Detail': 'جزئیات',
  'Really disable this account?': 'این حساب واقعاً غیرفعال شود؟',
  'Really issue a new one-time password?': 'گذرواژه یک‌بارمصرف جدید صادر شود؟',
  'Nothing left to review.': 'موردی برای بازبینی باقی نمانده است.',
  'No boxes drawn': 'کادری کشیده نشده',
  "This patient's report does not describe any polyp.":
    'گزارش این بیمار هیچ پولیپی را ذکر نکرده است.',
  "This patient's report describes a polyp.":
    'گزارش این بیمار یک پولیپ را توصیف کرده است.',
  'Is this a real lesion the report did not record?':
    'آیا این یک ضایعه واقعی است که در گزارش ثبت نشده؟',
  'Is the polyp really visible in the image you just marked?':
    'آیا پولیپ واقعاً در تصویری که علامت زدید دیده می‌شود؟',
  'Choose an explanation first.': 'ابتدا یک توضیح انتخاب کنید.',
  'Recorded. Images confirmed normal are what teach the model not to raise false alarms.':
    'ثبت شد. تصاویری که سالم تأیید می‌شوند به مدل می‌آموزند اشتباه تشخیص ندهد.',
  'Recorded with your mark. This becomes a training example with a location.':
    'همراه با علامت شما ثبت شد. این یک نمونه آموزشی با موقعیت مشخص می‌شود.',
  'Recorded as uncertain, and kept that way rather than forced into a label.':
    'به‌عنوان نامطمئن ثبت شد و به‌زور در یک برچسب قرار داده نشد.',
  '{n} labelled this session': '{n} تصویر در این جلسه',
  'You have finished this patient.': 'بررسی این بیمار را کامل کردید.',
  "This patient's report records no polyp.": 'گزارش این بیمار هیچ پولیپی ثبت نکرده است.',
  "This patient's report describes a polyp:": 'گزارش این بیمار پولیپ را توصیف کرده است:',
  'You marked a lesion the report does not record. Do you stand by it?':
    'شما ضایعه‌ای را علامت زدید که در گزارش نیست. بر نظر خود هستید؟',
  'Is what you marked the polyp the report describes?':
    'آیا آنچه علامت زدید همان پولیپ توصیف‌شده در گزارش است؟',
  'Images labelled': 'تصاویر برچسب‌خورده',
  'Marked as polyp': 'علامت‌خورده به‌عنوان پولیپ',
  'Boxes drawn': 'کادرهای کشیده‌شده',
  'Minutes': 'دقیقه',
  'About {sec}s per image.': 'حدود {sec} ثانیه برای هر تصویر.',
  '{n} of these had never been reviewed by anyone before.':
    '{n} مورد از این‌ها تا کنون توسط هیچ‌کس بازبینی نشده بود.',
  '{n} patients reviewed in full.': '{n} بیمار به‌طور کامل بازبینی شد.',
  '{n} images labelled by you in total, across {k} sessions.':
    'در مجموع {n} تصویر توسط شما، در {k} جلسه.',
  '{done} of {total} images in the study now have a label ({pct}%).':
    '{done} از {total} تصویر این پژوهش اکنون برچسب دارند ({pct}٪).',
  'Images reviewed': 'تصاویر بازبینی‌شده',
  'Missed studies explained': 'مطالعات جامانده توضیح‌داده‌شده',
  'Found in missed studies': 'یافته در مطالعات جامانده',
  'Localisations confirmed': 'محل‌یابی‌های تأییدشده',
  'The model flagged {ai} of these {n} images. You marked {you}.':
    'هوش مصنوعی در {ai} تصویر از این {n} تصویر پولیپ پیدا کرده بود. شما {you} مورد را علامت زدید.',
  "Next image":
    "تصویر بعدی",
  "The dashed box is where the AI thought it was (confidence {c}).":
    "کادر خط‌چین جایی است که هوش مصنوعی گمان کرده بود (اطمینان {c}).",
  "The model flagged {ai} of these {n} images. The one you marked is outlined.":
    "هوش مصنوعی در {ai} تصویر از این {n} تصویر پولیپ پیدا کرده بود. تصویری که شما علامت زدید مشخص شده است.",
  "Is there really a polyp there?":
    "آیا واقعاً آنجا پولیپ وجود دارد؟",
  "Yes, I stand by it":
    "بله، بر نظرم هستم",
  "No, I withdraw it":
    "نه، پس می‌گیرم",
  "Back":
    "تصویر قبلی",
  "You answered: {v}. Change it if you want.":
    "پاسخ شما: {v}. در صورت تمایل می‌توانید تغییر دهید.",
  "Yes, polyp":
    "بله، پولیپ",
  "No polyp":
    "پولیپ ندارد",
  "Not sure":
    "مطمئن نیستم",
  "See this whole patient":
    "مشاهده کل این بیمار",
  "All images from this patient":
    "همه تصاویر این بیمار",
  "Back to review":
    "بازگشت به بازبینی",
  "Close":
    "بستن",
  "The model flagged {ai} of these {n} images.":
    "هوش مصنوعی در {ai} تصویر از این {n} تصویر پولیپ پیدا کرده بود.",
  "Click any image to label it. Your answers are saved as reviewed with the report in view.":
    "برای برچسب‌زدن روی هر تصویر کلیک کنید. پاسخ‌های شما به‌عنوان «بررسی‌شده با گزارش» ثبت می‌شود.",
  "Drag on the image to mark it (optional)":
    "برای علامت‌گذاری روی تصویر بکشید (اختیاری)",
  "What would you like to do?":
    "می‌خواهید چه کاری انجام دهید؟",
  "Review images":
    "بازبینی تصاویر",
  "Admin panel":
    "پنل مدیریت",
  "Hello, {name}":
    "سلام، {name}",
  "Look at colonoscopy images and say whether you see a polyp.":
    "تصاویر کولونوسکوپی را ببینید و بگویید پولیپ می‌بینید یا نه.",
  "Accounts, progress, activity log, and data export.":
    "حساب‌ها، پیشرفت، گزارش فعالیت و دریافت داده‌ها.",
  "Add a box":
    "افزودن کادر",
  "Done drawing":
    "پایان رسم",
  "Where is it? (optional)":
    "کجاست؟ (اختیاری)",
  "Marking the spot is helpful but not required — Continue saves your answer as it is.":
    "مشخص‌کردن محل مفید است اما الزامی نیست — «ادامه» پاسخ شما را همان‌طور ثبت می‌کند.",
  "Drag on the image to draw. Tap the red ✕ on a box to remove it.":
    "برای رسم روی تصویر بکشید. برای حذف یک کادر، روی ✕ قرمز آن بزنید.",
  "Feedback":
    "بازخوردها",
  "Patient reviews":
    "بازبینی بیماران",
  "Retired":
    "کنارگذاشته‌شده",
  "retired":
    "کنارگذاشته",
  "Labelled":
    "برچسب‌خورده",
  "Said polyp":
    "پولیپ اعلام شده",
  "Case":
    "مورد",
  "Answer":
    "پاسخ",
  "Seconds":
    "ثانیه",
  "Retire all of this reader's feedback":
    "کنار گذاشتن همه بازخوردهای این بازبین",
  "Restore this reader's feedback":
    "بازگرداندن بازخوردهای این بازبین",
  "Take every answer by this reader out of the data? Nothing is deleted — it can be restored.":
    "همه پاسخ‌های این بازبین از داده‌ها کنار گذاشته شود؟ چیزی حذف نمی‌شود و قابل بازگرداندن است.",
  "Put this reader's answers back into the data?":
    "پاسخ‌های این بازبین به داده‌ها بازگردانده شود؟",
  "{n} answers updated.":
    "{n} پاسخ به‌روزرسانی شد.",
  "The report is wrong, or does not belong to these images":
    "گزارش اشتباه است، یا مربوط به این تصاویر نیست",
  "Click any image above to change what you said about it — including one you now think you got wrong.":
    "برای تغییر پاسخ خود روی هر تصویر بالا کلیک کنید — از جمله موردی که فکر می‌کنید اشتباه پاسخ داده‌اید.",
  "Explain in your own words (optional)":
    "با بیان خودتان توضیح دهید (اختیاری)",
  "Home":
    "خانه",
  "NoorMind home":
    "صفحه اصلی نورمایند",
  'Coverage by group': 'پوشش به تفکیک گروه',
  'Group': 'گروه',
  'Images': 'تصویر',
  'Remaining': 'باقی‌مانده',
  'AI fired, report clean': 'هوش مصنوعی پولیپ پیدا کرد، گزارش پاک',
  'Report has polyp, AI silent': 'گزارش پولیپ دارد، هوش مصنوعی ساکت',
  'Both agree': 'هر دو موافق',
  'Quiet control': 'شاهد بدون تشخیص',
  '{n} box': '{n} کادر',
  '{n} boxes': '{n} کادر',
};

/* Readable names for the pool groups. Admin-only: a reader is never told which
 * group an item came from. */
const BUCKET = {
  fp: 'AI fired, report clean',
  fn: 'Report has polyp, AI silent',
  tp: 'Both agree',
  tn: 'Quiet control',
};

let LANG = localStorage.getItem('noormind_lang') || 'fa';
const staticFa = new WeakMap();

function t(key, vars) {
  let s = (LANG === 'fa' && FA[key]) ? FA[key] : key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

function captureFarsi() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    staticFa.set(el, el.textContent);
  });
}

function applyLang() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === 'fa' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = LANG === 'fa' ? (staticFa.get(el) || el.dataset.i18n)
                                   : el.dataset.i18n;
  });
  $('langBtn').textContent = LANG === 'fa' ? 'EN' : 'فا';
  localStorage.setItem('noormind_lang', LANG);
  if (state.view === 'admin') renderAdmin();
}

/* ------------------------------------------------------------------ utils */
const $ = id => document.getElementById(id);
const state = {me: null, csrf: null, session: null, item: null, shownAt: 0,
               boxes: [], view: null, sheet: []};

async function api(path, opts) {
  opts = opts || {};
  const h = Object.assign({'Content-Type': 'application/json'}, opts.headers);
  if (state.csrf) h['X-CSRF-Token'] = state.csrf;
  const r = await fetch(API + path, Object.assign({}, opts, {
    headers: h, credentials: 'same-origin'}));
  let body = null;
  try { body = await r.json(); } catch (e) { /* empty or a file */ }
  if (!r.ok) {
    if (r.status === 401 && state.me) { hardLogout(); }
    const err = new Error((body && body.detail) || t('Something went wrong.'));
    err.status = r.status;
    throw err;
  }
  return body;
}

const post = (p, b) => api(p, {method: 'POST', body: JSON.stringify(b || {})});

function show(view) {
  state.view = view;
  ['viewLogin', 'viewChangePw', 'viewHome', 'viewStart', 'viewFrame',
   'viewDone', 'viewAdmin', 'viewCase', 'viewPatient'].forEach(v => {
    $(v).classList.toggle('hidden', v !== 'view' + view[0].toUpperCase() + view.slice(1));
  });
  const authed = !!state.me && !state.me.must_change_pw;
  const isAdmin = authed && state.me.role === 'admin';
  $('logoutBtn').classList.toggle('hidden', !state.me);
  // An admin does both jobs. Neither should ever be more than one tap away,
  // whichever they happen to be in the middle of.
  // Leaves the panel entirely, for the app the reviewers also use. Their own
  // way back around the panel is the brand and the two nav buttons.
  $('navHome').classList.toggle('hidden', !authed);
  $('navAdmin').classList.toggle('hidden', !(isAdmin && view !== 'admin'));
  $('navReview').classList.toggle('hidden',
    !(authed && view !== 'start' && view !== 'frame' && view !== 'case'
      && view !== 'patient'));
  $('who').textContent = state.me ? (state.me.display_name || state.me.username) : '';
  window.scrollTo(0, 0);
}

function hardLogout() {
  state.me = null; state.csrf = null; state.session = null;
  show('login');
  $('liErr').textContent = t('Session expired. Sign in again.');
}

/* ------------------------------------------------------------- box editor */
/* Boxes are held in natural image pixels so they survive any display scaling
 * and land in the same coordinate space as the model's own boxes. */
function BoxEditor(wrap, img, canvas, getBoxes, setBoxes, getAiBoxes) {
  const ctx = canvas.getContext('2d');
  let drag = null;
  // Off until asked for. A live canvas over the image means every stray swipe
  // on a phone lays down a box nobody meant to draw -- and a box nobody meant
  // to draw is a wrong location in the training data.
  let drawing = false;
  const HANDLE = 11;          // radius of the delete target, in screen px

  function setDraw(on) {
    drawing = !!on;
    canvas.classList.toggle('draw', drawing);
    draw();
  }
  function isDrawing() { return drawing; }

  function fit() {
    const r = img.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width));
    canvas.height = Math.max(1, Math.round(r.height));
    draw();
  }
  function scale() {
    return {sx: canvas.width / (img.naturalWidth || 1),
            sy: canvas.height / (img.naturalHeight || 1)};
  }
  function handleAt(b, sx, sy) {
    // Top-inner corner, so it never sits off the edge of the image.
    return [Math.min(b[0], b[2]) * sx + HANDLE, Math.min(b[1], b[3]) * sy + HANDLE];
  }
  function draw() {
    const {sx, sy} = scale();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // The model's boxes, amber and dashed, drawn only once the answer is in.
    const ai = getAiBoxes ? getAiBoxes() : [];
    if (ai && ai.length) {
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = '#e3b341';
      ai.forEach(b => ctx.strokeRect(b[0] * sx, b[1] * sy,
                                     (b[2] - b[0]) * sx, (b[3] - b[1]) * sy));
      ctx.setLineDash([]);
    }

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#2ea043';
    getBoxes().forEach(b => {
      ctx.strokeRect(b[0] * sx, b[1] * sy,
                     (b[2] - b[0]) * sx, (b[3] - b[1]) * sy);
      if (!drawing) return;
      // A delete target per box, so removing one does not mean clearing them all.
      const [hx, hy] = handleAt(b, sx, sy);
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE, 0, Math.PI * 2);
      ctx.fillStyle = '#f85149';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hx - 4, hy - 4); ctx.lineTo(hx + 4, hy + 4);
      ctx.moveTo(hx + 4, hy - 4); ctx.lineTo(hx - 4, hy + 4);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#2ea043';
    });

    if (drag) {
      ctx.strokeStyle = '#58a6ff';
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
      ctx.setLineDash([]);
    }
  }
  function at(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  canvas.addEventListener('pointerdown', e => {
    if (!drawing) return;
    const [x, y] = at(e);
    const {sx, sy} = scale();
    // Tapping a delete target removes that box instead of starting a new one.
    const boxes = getBoxes();
    for (let i = 0; i < boxes.length; i++) {
      const [hx, hy] = handleAt(boxes[i], sx, sy);
      if (Math.hypot(x - hx, y - hy) <= HANDLE + 4) {
        const next = boxes.slice();
        next.splice(i, 1);
        setBoxes(next);
        draw();
        return;
      }
    }
    canvas.setPointerCapture(e.pointerId);
    drag = {x0: x, y0: y, x1: x, y1: y};
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const [x, y] = at(e);
    drag.x1 = x; drag.y1 = y; draw();
  });
  canvas.addEventListener('pointerup', () => {
    if (!drag) return;
    const {sx, sy} = scale();
    const x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1);
    const y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
    drag = null;
    // Ignore taps and hairlines: a stray touch should not become a label.
    if (x1 - x0 > 8 && y1 - y0 > 8) {
      const b = getBoxes().slice();
      b.push([Math.round(x0 / sx), Math.round(y0 / sy),
              Math.round(x1 / sx), Math.round(y1 / sy)]);
      setBoxes(b);
    }
    draw();
  });
  img.addEventListener('load', fit);
  window.addEventListener('resize', fit);
  return {fit, draw, setDraw, isDrawing};
}

/* ------------------------------------------------------------------ login */
$('liGo').onclick = async () => {
  $('liErr').textContent = '';
  const btn = $('liGo'); btn.disabled = true;
  const was = btn.textContent; btn.textContent = t('Signing in…');
  try {
    const me = await post('/login', {
      username: $('liUser').value.trim(), password: $('liPass').value,
      totp: $('liTotp').value.trim() || null});
    state.me = me; state.csrf = me.csrf;
    $('liPass').value = ''; $('liTotp').value = '';
    afterAuth();
  } catch (e) {
    $('liErr').textContent = e.message;
  } finally { btn.disabled = false; btn.textContent = was; }
};
['liUser', 'liPass', 'liTotp'].forEach(id => {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('liGo').click(); });
});

$('logoutBtn').onclick = async () => {
  try { await post('/logout'); } catch (e) { /* going anyway */ }
  state.me = null; state.csrf = null; state.session = null;
  show('login');
};

$('cpGo').onclick = async () => {
  $('cpErr').textContent = '';
  if ($('cpNew').value !== $('cpNew2').value) {
    $('cpErr').textContent = t('Passwords do not match.'); return;
  }
  const btn = $('cpGo'); btn.disabled = true;
  try {
    const r = await post('/change-password',
                         {current: $('cpCur').value, new: $('cpNew').value});
    state.csrf = r.csrf;
    state.me.must_change_pw = false;
    ['cpCur', 'cpNew', 'cpNew2'].forEach(i => $(i).value = '');
    afterAuth();
  } catch (e) { $('cpErr').textContent = e.message; }
  finally { btn.disabled = false; }
};

function afterAuth() {
  if (state.me.must_change_pw) { show('changePw'); return; }
  // Readers have one job, so send them to it. Admins are asked, rather than
  // being dropped into the console and having to find the reading screen.
  if (state.me.role === 'admin') { openHome(); } else { openStart(); }
}

function openHome() {
  show('home');
  $('homeHi').textContent = t('Hello, {name}',
    {name: state.me.display_name || state.me.username});
}

// The brand is the way home, which is what people try first.
function goHome() {
  if (!state.me || state.me.must_change_pw) return;
  if (state.me.role === 'admin') openHome(); else openStart();
}

$('brandBtn').onclick = () => {
  goHome();
};

$('goReview').onclick = () => openStart();
$('goAdmin').onclick = () => openAdmin();

/* ------------------------------------------------------------------ start */
const N_CHOICES = [10, 20, 30, 50, 100];
let chosenN = 20;

function buildChips() {
  const box = $('nChips'); box.textContent = '';
  N_CHOICES.forEach(n => {
    const b = document.createElement('button');
    b.className = 'chip' + (n === chosenN ? ' on' : '');
    b.textContent = n;
    b.onclick = () => { chosenN = n; buildChips(); };
    box.appendChild(b);
  });
}

async function openStart() {
  show('start');
  buildChips();
  $('startErr').textContent = '';
  $('resumeBox').classList.add('hidden');
  try {
    const cur = await api('/session/current');
    if (cur.session) {
      state.session = cur.session;
      $('resumeTxt').textContent = t(
        'You have an unfinished session: {done} of {total} reviewed.',
        {done: cur.done, total: cur.total});
      $('resumeBox').classList.remove('hidden');
    }
  } catch (e) { /* nothing to resume */ }
}

$('resumeGo').onclick = () => nextItem();

$('startGo').onclick = async () => {
  $('startErr').textContent = '';
  const btn = $('startGo'); btn.disabled = true;
  try {
    const r = await post('/session', {n: chosenN});
    state.session = r.session;
    await nextItem();
  } catch (e) { $('startErr').textContent = e.message; }
  finally { btn.disabled = false; }
};

$('doneGo').onclick = () => openStart();
$('navReview').onclick = () => openStart();
$('navAdmin').onclick = () => openAdmin();

/* ----------------------------------------------------------------- review */
async function nextItem() {
  let it;
  try { it = await api('/session/' + state.session + '/next'); }
  catch (e) { $('startErr').textContent = e.message; show('start'); return; }

  if (it.done) { renderDone(it); return; }
  state.item = it;
  state.boxes = [];
  state.shownAt = Date.now();
  if (typeof it.position === 'number') state.lastPos = it.position;
  if (it.task === 'frame') renderFrame(it); else renderCase(it);
}

function progress(fill, txt, caseTxt, it) {
  const pct = it.total ? Math.round(100 * it.completed / it.total) : 0;
  $(fill).style.width = pct + '%';
  $(txt).textContent = t('{done} of {total}',
                         {done: it.completed + 1, total: it.total});
  $(caseTxt).textContent = t('Case {case}', {case: it.case});
}

/* Fallback when the per-image explanation is switched off server-side
 * (CV_EXPLAIN=0). True of any answer in any group, so it leaks nothing. */
const REWARD = {
  no_polyp: 'Recorded. Images confirmed normal are what teach the model not to raise false alarms.',
  polyp: 'Recorded with your mark. This becomes a training example with a location.',
  unsure: 'Recorded as uncertain, and kept that way rather than forced into a label.',
};

/* Why this image was in the study, and what the answer just given is worth.
 * The server sends only a key, and only AFTER the answer is stored. These
 * carry their own translation rather than going through the English-keyed
 * dictionary: they are long sentences full of quotes, and the indirection
 * buys nothing but escaping bugs. */
const WHY = {
  why_fp_no: {en: "The AI raised an alert on this image, but the report records no polyp. Your \"no\" confirms it was a false alarm — exactly the data that teaches the model to stop firing on images like it.",
    fa: "هوش مصنوعی در این تصویر پولیپ پیدا کرده بود، اما گزارش پزشک پولیپی ثبت نکرده است. پاسخ «ندارد» شما تأیید می‌کند که این تشخیص نادرست بوده — دقیقاً همین داده به مدل می‌آموزد در چنین تصاویری اشتباه تشخیص ندهد."},
  why_fp_yes: {en: "The AI raised an alert here and the report records no polyp. Your \"yes\" means this may be a lesion the report never recorded.",
    fa: "هوش مصنوعی در این تصویر پولیپ پیدا کرده، اما گزارش پولیپی ثبت نکرده است. پاسخ «بله» شما یعنی ممکن است ضایعه‌ای باشد که هرگز در گزارش ثبت نشده است."},
  why_fp_unsure: {en: "The AI raised an alert here and the report records no polyp. Marking it uncertain is useful in itself — it tells us the image is genuinely hard.",
    fa: "هوش مصنوعی در این تصویر پولیپ پیدا کرده، اما گزارش پولیپی ثبت نکرده است. ثبت تردید شما هم ارزشمند است — یعنی این تصویر واقعاً دشوار است."},
  why_fn_no: {en: "This patient has a polyp in the report, but the AI found nothing in any image. Your \"no\" helps settle whether the polyp was ever photographed at all.",
    fa: "گزارش این بیمار پولیپ را توصیف کرده، اما هوش مصنوعی در هیچ تصویری چیزی پیدا نکرده است. پاسخ «ندارد» شما کمک می‌کند بدانیم آیا پولیپ اصلاً عکس‌برداری شده بوده یا نه."},
  why_fn_yes: {en: "The report describes a polyp the AI missed completely. Your mark gives us a positive example with a location — the most valuable kind for retraining.",
    fa: "گزارش پولیپی را توصیف کرده که هوش مصنوعی کاملاً از دست داده است. علامت شما یک نمونه مثبت همراه با موقعیت می‌دهد — ارزشمندترین نوع داده برای بازآموزی مدل."},
  why_fn_unsure: {en: "The report describes a polyp the AI missed. Uncertainty here is informative: it suggests the lesion is subtle rather than absent.",
    fa: "گزارش پولیپی را توصیف کرده که هوش مصنوعی از دست داده است. تردید شما اینجا آموزنده است: یعنی ضایعه ظریف است، نه غایب."},
  why_tp_yes: {en: "Both the AI and the report indicate a polyp for this patient. Your \"yes\" confirms the AI alerted on the right image.",
    fa: "هم هوش مصنوعی و هم گزارش برای این بیمار پولیپ را نشان می‌دهند. پاسخ «بله» شما تأیید می‌کند که هوش مصنوعی روی تصویر درست پولیپ پیدا کرده است."},
  why_tp_no: {en: "The AI alerted here and this patient does have a polyp in the report — but you see none in this image. That points to the AI firing on the wrong image, which a patient-level label could never have revealed.",
    fa: "هوش مصنوعی در این تصویر پولیپ پیدا کرده و این بیمار در گزارش هم پولیپ دارد — اما شما در این تصویر چیزی نمی‌بینید. یعنی هوش مصنوعی روی تصویر اشتباه پولیپ پیدا کرده؛ چیزی که برچسب سطح بیمار هرگز نمی‌توانست نشان دهد."},
  why_tp_unsure: {en: "The AI alerted here and the report describes a polyp for this patient. Your uncertainty tells us the alert is at least not obviously right.",
    fa: "هوش مصنوعی در این تصویر پولیپ پیدا کرده و گزارش این بیمار هم پولیپ دارد. تردید شما نشان می‌دهد این تشخیص دست‌کم بدیهی نیست."},
  why_tn_no: {en: "Neither the AI nor the report indicates anything here. These are the controls that let us measure how often the model is correctly silent.",
    fa: "نه هوش مصنوعی و نه گزارش، هیچ‌کدام اینجا چیزی نشان نمی‌دهند. این‌ها شاهدهایی هستند که به ما امکان می‌دهند بسنجیم مدل چقدر به‌درستی ساکت می‌ماند."},
  why_tn_yes: {en: "Neither the AI nor the report indicates anything here, so your mark is worth a second look.",
    fa: "نه هوش مصنوعی و نه گزارش اینجا چیزی نشان نمی‌دهند، بنابراین علامت شما ارزش بررسی دوباره دارد."},
  why_tn_unsure: {en: "Neither the AI nor the report indicates anything here. Recorded as uncertain.",
    fa: "نه هوش مصنوعی و نه گزارش اینجا چیزی نشان نمی‌دهند. به‌عنوان نامطمئن ثبت شد."},
};

let frameEditor = null;

function renderFrame(it) {
  show('frame');
  progress('progFill', 'progTxt', 'caseTxt', it);
  $('qBlind').classList.remove('hidden');
  $('qBox').classList.add('hidden');
  $('qAfter').classList.add('hidden');
  $('qConfirm').classList.add('hidden');
  state.aiBoxes = [];
  const img = $('frameImg');
  img.src = it.image;
  if (!frameEditor) {
    frameEditor = BoxEditor($('frameWrap'), img, $('frameCanvas'),
                            () => state.boxes,
                            b => { state.boxes = b;
                                   $('bClear').classList.toggle('hidden', !b.length); },
                            () => state.aiBoxes);
  }
  frameEditor.setDraw(false);
  frameEditor.fit();
  $('bBackQ').classList.toggle('hidden', !(it.position > 0));
}

/* ------------------------------------------------------- after the answer */
/* Everything below happens on the image the reader just answered -- never on
 * top of the next one -- and none of it existed in the browser until the
 * answer was stored. */

function showAfter(verdict, r) {
  $('qBlind').classList.add('hidden');
  $('qBox').classList.add('hidden');

  const w = r && r.why && WHY[r.why];
  $('afterWhy').textContent = w ? (LANG === 'fa' ? w.fa : w.en)
                                : t(REWARD[verdict]);

  // Draw the model's boxes on the same image, so "the AI thought it was here"
  // is a place on the picture rather than a sentence.
  state.aiBoxes = (r && r.ai_boxes) || [];
  frameEditor.draw();
  const hasAi = state.aiBoxes.length > 0;
  $('afterAi').classList.toggle('hidden', !hasAi);
  if (hasAi) {
    $('afterAi').textContent = t(
      'The dashed box is where the AI thought it was (confidence {c}).',
      {c: (r.ai_conf || 0).toFixed(2)});
  }
  state.myVerdict = verdict;
  paintVerdictButtons();
  $('afterYours').textContent = t('You answered: {v}. Change it if you want.',
                                  {v: t(VERDICT_LABEL[verdict] || verdict)});
  $('bBack').classList.toggle('hidden', !(state.item && state.item.position > 0));
  $('qAfter').classList.remove('hidden');
  startAutoNext();
}

const VERDICT_LABEL = {polyp: 'Yes, polyp', no_polyp: 'No polyp', unsure: 'Not sure'};

function paintVerdictButtons() {
  const map = {eYes: 'polyp', eNo: 'no_polyp', eUnsure: 'unsure'};
  for (const id in map) {
    $(id).classList.toggle('on', map[id] === state.myVerdict);
  }
}

/* Revising is allowed for as long as the session lasts. A reader ten images in
 * understands the task better than they did on image one, and letting them fix
 * an early answer is worth more than the tidiness of never changing anything --
 * the old answer is kept and flagged, so nothing is lost by allowing it. */
async function reviseTo(verdict) {
  if (verdict === state.myVerdict) return;
  clearAutoNext();
  const r = await post('/revise', {wid: state.item.wid, verdict: verdict,
                                   boxes: state.boxes,
                                   ms: Date.now() - state.shownAt});
  state.myVerdict = verdict;
  paintVerdictButtons();
  const w = r && r.why && WHY[r.why];
  $('afterWhy').textContent = w ? (LANG === 'fa' ? w.fa : w.en)
                                : t(REWARD[verdict]);
  $('afterYours').textContent = t('You answered: {v}. Change it if you want.',
                                  {v: t(VERDICT_LABEL[verdict] || verdict)});
  startAutoNext();
}

$('eYes').onclick = () => reviseTo('polyp');
$('eNo').onclick = () => reviseTo('no_polyp');
$('eUnsure').onclick = () => reviseTo('unsure');

/* ------------------------------------------------------------- navigation */
$('bBack').onclick = async () => {
  clearAutoNext();
  const pos = state.item.position - 1;
  if (pos < 0) return;
  let it;
  try { it = await api('/session/' + state.session + '/at/' + pos); }
  catch (e) { return; }
  renderReviewed(it);
};

/* An image already answered, reopened. Same layout, their answer restored. */
function renderReviewed(it) {
  state.item = it;
  state.boxes = it.my_boxes || [];
  state.aiBoxes = it.ai_boxes || [];
  state.shownAt = Date.now();
  show('frame');
  progress('progFill', 'progTxt', 'caseTxt', it);
  $('qBlind').classList.add('hidden');
  $('qBox').classList.add('hidden');
  $('qConfirm').classList.add('hidden');
  const img = $('frameImg');
  img.src = it.image;
  if (!frameEditor) {
    frameEditor = BoxEditor($('frameWrap'), img, $('frameCanvas'),
                            () => state.boxes,
                            b => { state.boxes = b;
                                   $('bClear').classList.toggle('hidden', !b.length); },
                            () => state.aiBoxes);
  }
  frameEditor.setDraw(false);
  frameEditor.fit();
  showAfter(it.my_verdict, it);
}

/* A minute, or Continue -- whichever comes first. This is a backstop against a
 * session stalling on a screen nobody is looking at, not a pace-setter: reading
 * the explanation and studying where the model put its box is the part that
 * makes the reveal worth having, and it should never be the thing rushing. */
const AUTO_NEXT_MS = 60000;

function startAutoNext() {
  clearAutoNext();
  let left = Math.round(AUTO_NEXT_MS / 1000);
  $('nextCount').textContent = ' (' + left + ')';
  state.autoStart = Date.now();
  state.autoTick = setInterval(() => {
    left -= 1;
    $('nextCount').textContent = left > 0 ? ' (' + left + ')' : '';
  }, 1000);
  state.autoTimer = setTimeout(() => { clearAutoNext(); nextItem(); }, AUTO_NEXT_MS);
}

function clearAutoNext() {
  clearTimeout(state.autoTimer);
  clearInterval(state.autoTick);
  $('nextCount').textContent = '';
}

$('bNext').onclick = () => {
  clearAutoNext();
  // Forward through images already answered, then back to the live worklist.
  const p = state.item.position + 1;
  if (state.item.reviewing && p < state.lastPos) {
    api('/session/' + state.session + '/at/' + p)
      .then(renderReviewed).catch(() => nextItem());
  } else {
    nextItem();
  }
};

async function sendAnswer(verdict) {
  const r = await post('/answer', {wid: state.item.wid, verdict: verdict,
                                   boxes: state.boxes,
                                   ms: Date.now() - state.shownAt});
  state.labelled = (state.labelled || 0) + 1;
  if (r && r.next === 'confirm') showConfirm(verdict, r);
  else showAfter(verdict, r);
}

$('bYes').onclick = () => {
  // Offer a box, do not impose one. Where the reader saw it is what makes the
  // answer comparable to the model's, but a "yes" with no location is still a
  // useful label, and Continue takes it as-is.
  $('qBlind').classList.add('hidden');
  $('qBox').classList.remove('hidden');
  // This panel exists to ask for a box, so drawing is already live. The canvas
  // is inert everywhere else, which is what keeps a stray swipe on a phone from
  // laying down a box nobody meant.
  setDrawMode(true);
};
$('bNo').onclick = () => sendAnswer('no_polyp');
$('bUnsure').onclick = () => sendAnswer('unsure');

function setDrawMode(on) {
  frameEditor.setDraw(on);
  $('bClear').classList.toggle('hidden', !state.boxes.length);
}

$('bClear').onclick = () => {
  state.boxes = [];
  frameEditor.draw();
  setDrawMode(true);
};
$('bBoxDone').onclick = () => { setDrawMode(false); sendAnswer('polyp'); };

/* ----------------------------------------- clean patient, reader found one */
/* No countdown here: this one needs an answer, so it waits. */
function showConfirm(verdict, r) {
  $('qBlind').classList.add('hidden');
  $('qBox').classList.add('hidden');
  $('qAfter').classList.add('hidden');
  clearAutoNext();

  const w = r.why && WHY[r.why];
  $('confirmWhy').textContent = w ? (LANG === 'fa' ? w.fa : w.en) : '';
  state.aiBoxes = r.ai_boxes || [];
  frameEditor.draw();

  const c = r.confirm;
  $('confirmReport').textContent = c.report || '—';
  $('confirmLegend').textContent = t(
    'The model flagged {ai} of these {n} images. The one you marked is outlined.',
    {ai: c.ai_flagged, n: (c.frames || []).length});

  const sheet = $('confirmSheet');
  sheet.textContent = '';
  (c.frames || []).forEach((f, i) => {
    const d = el('div', 'tile' + (i === c.this_frame ? ' me' : '') + (f.ai ? ' ai' : ''));
    const im = document.createElement('img');
    im.src = f.url; im.loading = 'lazy'; im.alt = '';
    d.appendChild(im);
    sheet.appendChild(d);
  });
  $('qConfirm').classList.remove('hidden');
  state.shownAt = Date.now();
}

async function sendInlineConfirm(v) {
  await post('/answer-confirm', {wid: state.item.wid, verdict: v,
                                 ms: Date.now() - state.shownAt});
  nextItem();
}
$('bConfirmYes').onclick = () => sendInlineConfirm('confirm');
$('bConfirmNo').onclick = () => sendInlineConfirm('retract');
$('bConfirmUnsure').onclick = () => sendInlineConfirm('unsure');


/* --------------------------------------------------------- patient view */
/* Opened on demand from an image the reader has already answered. The report
 * is on screen here, so every label made from this view is recorded open-book
 * (stage='open') and never replaces the blind answer. Both are kept: what a
 * reader thinks looking at one image alone, and what they think with the whole
 * patient in front of them, are different measurements. */
let patientEditor = null;
let pmIdx = -1, pmBoxes = [], pmAi = [];

async function openPatient() {
  clearAutoNext();
  let p;
  try { p = await api('/patient/' + state.item.wid); }
  catch (e) { return; }
  p.wid = state.item.wid;
  p.sheetId = 'pSheet';
  state.patient = p;
  state.returnTo = {position: state.item.position, wid: state.item.wid};
  show('patient');

  $('pTitle').textContent = t('All images from this patient');
  $('pCase').textContent = t('Case {case}', {case: p.case});
  $('pHead').textContent = p.report_polyp
    ? t("This patient's report describes a polyp:")
    : t("This patient's report records no polyp.");
  const bits = [p.finding, p.size_mm && p.size_mm + ' mm', p.morphology,
                p.location].filter(Boolean);
  $('pFinding').textContent = bits.join(' · ');
  $('pFinding').classList.toggle('hidden', !p.report_polyp || !bits.length);
  $('pReport').textContent = p.report || '—';
  $('pLegend').textContent = t(
    'The model flagged {ai} of these {n} images.',
    {ai: p.ai_flagged, n: (p.frames || []).length});
  drawPatientSheet();
}

function drawPatientSheet() {
  const p = state.patient;
  const sheet = $('pSheet');
  sheet.textContent = '';
  (p.frames || []).forEach((f, i) => {
    const mine = p.mine[String(i)];
    const yes = mine && mine.verdict === 'polyp';
    const d = el('div', 'tile' + (yes ? ' on' : '') + (f.ai ? ' ai' : '') +
                        (i === p.this_frame ? ' me' : ''));
    const im = document.createElement('img');
    im.src = f.url; im.loading = 'lazy'; im.alt = '';
    d.appendChild(im);
    if (mine) {
      d.appendChild(el('span', 'nbox', mine.verdict === 'polyp' ? '✓'
                       : mine.verdict === 'unsure' ? '?' : '–'));
    }
    d.onclick = () => openLabelModal(i, state.patient);
    sheet.appendChild(d);
  });
}

function openLabelModal(i, ctx) {
  const p = ctx || state.patient;
  state.pmCtx = p;
  pmIdx = i;
  const mine = p.mine[String(i)];
  pmBoxes = mine ? (mine.boxes || []).slice() : [];
  pmAi = [];
  $('pmImg').src = p.frames[i].url;
  $('pModal').classList.remove('hidden');
  if (!patientEditor) {
    patientEditor = BoxEditor($('pmWrap'), $('pmImg'), $('pmCanvas'),
                              () => pmBoxes,
                              b => { pmBoxes = b;
                                     $('pmClear').classList.toggle('hidden', !b.length); },
                              () => pmAi);
  }
  patientEditor.fit();
  setPmDraw(true);
  state.pmShown = Date.now();
}

async function labelOpen(verdict) {
  const ctx = state.pmCtx;
  await post('/label-open', {
    wid: ctx.wid, frame_index: pmIdx, verdict: verdict,
    boxes: pmBoxes, ms: Date.now() - state.pmShown});
  ctx.mine[String(pmIdx)] = {verdict: verdict, stage: 'open',
                             boxes: pmBoxes.slice()};
  $('pModal').classList.add('hidden');
  if (ctx.sheetId === 'cSheet') {
    drawCaseSheet();
    // Finding one now changes what the debrief is asking, so move the
    // explanation to match rather than leave a contradiction on screen.
    if (verdict === 'polyp') pickReason('now_visible');
  } else {
    drawPatientSheet();
  }
}

$('pmYes').onclick = () => labelOpen('polyp');
$('pmNo').onclick = () => labelOpen('no_polyp');
$('pmUnsure').onclick = () => labelOpen('unsure');
function setPmDraw(on) {
  patientEditor.setDraw(on);
  $('pmClear').classList.toggle('hidden', !pmBoxes.length);
}
$('pmClear').onclick = () => { pmBoxes = []; patientEditor.draw(); setPmDraw(true); };
$('pmClose').onclick = () => $('pModal').classList.add('hidden');

/* Straight back into the main thread, at the image they left. */
$('pBack').onclick = async () => {
  const pos = state.returnTo.position;
  try {
    const it = await api('/session/' + state.session + '/at/' + pos);
    renderReviewed(it);
  } catch (e) { nextItem(); }
};

$('bPatient').onclick = openPatient;

$('bBackQ').onclick = async () => {
  const pos = state.item.position - 1;
  if (pos < 0) return;
  try {
    const it = await api('/session/' + state.session + '/at/' + pos);
    renderReviewed(it);
  } catch (e) { /* nothing behind us */ }
};

/* --------------------------------------------------------- patient review */
/* One screen per patient, reached only once every one of that patient's images
 * already has an independent answer. Nothing is revealed before that point. */
let caseReason = null;

function renderCase(it) {
  show('case');
  progress('cProgFill', 'cProgTxt', 'cCaseTxt', it);
  const isConfirm = it.task === 'case_confirm';
  const clean = !it.report_polyp;
  const marked = new Set(it.marked || []);

  $('cHead').textContent = isConfirm
    ? t('You have finished this patient.')
    : t('You found no polyp in any image of this patient.');
  $('cSub').textContent = clean
    ? t("This patient's report records no polyp.")
    : t("This patient's report describes a polyp:");

  const bits = [it.finding, it.size_mm && it.size_mm + ' mm', it.morphology,
                it.location].filter(Boolean);
  $('cFinding').textContent = bits.join(' · ');
  $('cFinding').classList.toggle('hidden', clean || !bits.length);
  $('cReport').textContent = it.report || '—';

  $('cAskConfirm').classList.toggle('hidden', !isConfirm);
  $('cAskDebrief').classList.toggle('hidden', isConfirm);
  if (isConfirm) {
    $('cQuestion').textContent = clean
      ? t('You marked a lesion the report does not record. Do you stand by it?')
      : t('Is what you marked the polyp the report describes?');
  } else {
    caseReason = null;
    $('cNote').value = '';
    $('cErr').textContent = '';
    document.querySelectorAll('#cAskDebrief .reason')
            .forEach(b => b.classList.remove('on'));
  }

  // Now the reader sees what the model thought -- and only now, because every
  // one of this patient's images already has its own answer.
  $('cLegend').textContent = t(
    'The model flagged {ai} of these {n} images. You marked {you}.',
    {ai: it.ai_flagged, n: (it.frames || []).length, you: marked.size});

  state.caseCtx = {wid: it.wid, frames: it.frames || [], mine: {},
                   sheetId: 'cSheet', editable: !isConfirm};
  marked.forEach(i => {
    state.caseCtx.mine[String(i)] = {verdict: 'polyp', stage: 'blind', boxes: []};
  });
  drawCaseSheet();
  // Fetch what this reader actually said about every image of the patient, so
  // the grid shows all their work and not only the ones they said yes to.
  api('/patient/' + it.wid).then(p => {
    if (p.mine) state.caseCtx.mine = p.mine;
    if (p.frames) state.caseCtx.frames = p.frames;
    drawCaseSheet();
  }).catch(() => {});
}

/* The patient's images on the review screen. Clickable in the debrief, where
 * the whole point is to let a reader fix an answer they now think was wrong,
 * and read-only on a confirm, where their marks are a record. */
function drawCaseSheet() {
  const ctx = state.caseCtx;
  const sheet = $('cSheet');
  sheet.textContent = '';
  (ctx.frames || []).forEach((f, i) => {
    const mine = ctx.mine[String(i)];
    const yes = mine && mine.verdict === 'polyp';
    const d = el('div', 'tile' + (yes ? ' on' : '') + (f.ai ? ' ai' : ''));
    const im = document.createElement('img');
    im.src = f.url; im.loading = 'lazy'; im.alt = '';
    d.append(im, el('span', 'mark', '✓'));
    if (mine) {
      d.appendChild(el('span', 'nbox', mine.verdict === 'polyp' ? '✓'
                       : mine.verdict === 'unsure' ? '?' : '–'));
    }
    if (ctx.editable) d.onclick = () => openLabelModal(i, ctx);
    sheet.appendChild(d);
  });
}

function pickReason(reason) {
  caseReason = reason;
  document.querySelectorAll('#cAskDebrief .reason').forEach(b =>
    b.classList.toggle('on', b.dataset.reason === reason));
}

document.querySelectorAll('#cAskDebrief .reason').forEach(b => {
  b.onclick = () => pickReason(b.dataset.reason);
});

async function sendConfirm(v) {
  await post('/answer-confirm', {wid: state.item.wid, verdict: v,
                                ms: Date.now() - state.shownAt});
  nextItem();
}
$('bConfirm').onclick = () => sendConfirm('confirm');
$('bRetract').onclick = () => sendConfirm('retract');
$('bConfUnsure').onclick = () => sendConfirm('unsure');

$('cSave').onclick = async () => {
  if (!caseReason) { $('cErr').textContent = t('Choose an explanation first.'); return; }
  const mine = (state.caseCtx && state.caseCtx.mine) || {};
  const marked = Object.keys(mine)
                       .filter(k => mine[k].verdict === 'polyp')
                       .map(Number).sort((a, b) => a - b);
  await post('/answer-debrief', {
    wid: state.item.wid, reason: caseReason, frames: marked,
    note: $('cNote').value.trim() || null, ms: Date.now() - state.shownAt});
  nextItem();
};

/* ------------------------------------------------------------ end of session */
async function renderDone(it) {
  show('done');
  $('doneTxt').textContent = t('You reviewed {n} images. Thank you.',
                               {n: it.completed});
  const box = $('doneStats');
  box.textContent = '';
  let s;
  try { s = await api('/session/' + state.session + '/summary'); }
  catch (e) { return; }

  const mins = Math.max(1, Math.round(s.seconds / 60));
  [[t('Images labelled'), s.reviewed],
   [t('Marked as polyp'), s.polyp],
   [t('Boxes drawn'), s.boxes],
   [t('Minutes'), mins]].forEach(([k, v]) => {
    const d = el('div', 'stat');
    d.appendChild(el('b', '', v));
    d.appendChild(el('span', 'muted small', k));
    box.appendChild(d);
  });

  const lines = [];
  lines.push(t('About {sec}s per image.', {sec: s.median_s}));
  if (s.first_labelled)
    lines.push(t('{n} of these had never been reviewed by anyone before.',
                 {n: s.first_labelled}));
  if (s.confirmed || s.debriefs)
    lines.push(t('{n} patients reviewed in full.',
                 {n: s.confirmed + s.debriefs}));
  lines.push(t('{n} images labelled by you in total, across {k} sessions.',
               {n: s.lifetime, k: s.sessions_done}));
  $('doneContrib').textContent = lines.join(' ');

  const pct = s.pool_total ? Math.round(100 * s.pool_done / s.pool_total) : 0;
  $('poolFill').style.width = pct + '%';
  $('poolTxt').textContent = t(
    '{done} of {total} images in the study now have a label ({pct}%).',
    {done: s.pool_done, total: s.pool_total, pct: pct});
}

/* ------------------------------------------------------------------ admin */
async function openAdmin() {
  show('admin');
  await renderAdmin();
}

let adminCache = {users: null, stats: null, audit: null};

async function renderAdmin() {
  try {
    const [users, stats, audit] = await Promise.all([
      api('/admin/users'), api('/admin/stats'), api('/admin/audit?limit=120')]);
    adminCache = {users, stats, audit};
  } catch (e) { return; }
  drawUsers(adminCache.users);
  drawStats(adminCache.stats);
  drawAudit(adminCache.audit);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtTime(ts) {
  if (!ts) return t('never');
  return new Date(ts * 1000).toLocaleString(LANG === 'fa' ? 'fa-IR' : 'en-GB');
}

function drawUsers(users) {
  const box = $('userTable'); box.textContent = '';
  const tb = el('table');
  const hr = el('tr');
  [t('User'), t('Role'), t('Status'), t('Reviewed'), t('Last sign-in'),
   t('Actions')].forEach((h, i) => {
    const th = el('th', i === 3 ? 'num' : '', h); hr.appendChild(th);
  });
  tb.appendChild(el('thead')).appendChild(hr);
  const body = el('tbody');
  users.forEach(u => {
    const tr = el('tr');
    const name = el('td');
    name.appendChild(el('div', '', u.display_name || u.username));
    name.appendChild(el('div', 'muted small', u.username));
    tr.appendChild(name);
    tr.appendChild(el('td', '', u.role === 'admin' ? t('Administrator') : t('Reviewer')));
    const st = el('td');
    st.appendChild(el('span', 'tag ' + (u.is_active ? 'on' : 'off'),
                      u.is_active ? t('active') : t('disabled')));
    if (u.must_change_pw) st.appendChild(el('div', 'muted small', t('must change password')));
    tr.appendChild(st);
    tr.appendChild(el('td', 'num', u.reviewed || 0));
    tr.appendChild(el('td', 'small', fmtTime(u.last_login_at)));
    const act = el('td');
    const detail = el('button', 'ghost small', t('Feedback'));
    detail.onclick = () => openReader(u.id);
    act.appendChild(detail);
    const reset = el('button', 'ghost small', t('Reset password'));
    reset.onclick = async () => {
      if (!confirm(t('Really issue a new one-time password?'))) return;
      const r = await post('/admin/users/' + u.id, {reset_password: true});
      showCreds(u.username, r.temp_password, t('New one-time password'));
      renderAdmin();
    };
    act.appendChild(reset);
    if (u.username !== state.me.username) {
      const tog = el('button', 'ghost small', u.is_active ? t('Disable') : t('Enable'));
      tog.onclick = async () => {
        if (u.is_active && !confirm(t('Really disable this account?'))) return;
        await post('/admin/users/' + u.id, {is_active: !u.is_active});
        renderAdmin();
      };
      act.appendChild(tog);
    }
    tr.appendChild(act);
    body.appendChild(tr);
  });
  tb.appendChild(body);
  box.appendChild(tb);
}

function showCreds(username, password, title) {
  const out = $('nuOut');
  out.textContent = '';
  out.appendChild(el('b', '', title));
  const line = el('div');
  line.appendChild(el('span', '', 'username: '));
  line.appendChild(el('code', '', username));
  out.appendChild(line);
  const line2 = el('div');
  line2.appendChild(el('span', '', 'password: '));
  line2.appendChild(el('code', '', password));
  out.appendChild(line2);
  out.appendChild(el('p', 'small', t(
    'Give these to the reviewer over a channel you trust. The password is shown once and cannot be recovered.')));
  out.classList.remove('hidden');
}

$('nuGo').onclick = async () => {
  $('nuErr').textContent = '';
  try {
    const r = await post('/admin/users', {
      username: $('nuUser').value.trim(),
      display_name: $('nuName').value.trim(),
      role: $('nuRole').value});
    showCreds(r.username, r.temp_password, t('Account created'));
    $('nuUser').value = ''; $('nuName').value = '';
    renderAdmin();
  } catch (e) { $('nuErr').textContent = e.message; }
};


/* ------------------------------------------------- one reader's feedback */
/* A reader's work judged as a body rather than as one line in a summary: the
 * shape of their yes-rate per group, how their pace moved, and every answer
 * they gave. If it does not hold up, the whole lot can be retired in one go. */
let readerCache = null;

async function openReader(uid) {
  let d;
  try { d = await api('/admin/reader/' + uid); } catch (e) { return; }
  readerCache = d;
  $('readerCard').classList.remove('hidden');
  $('readerName').textContent = (d.user.display_name || d.user.username)
    + ' — ' + t('Feedback');

  const box = $('readerSummary');
  box.textContent = '';
  const grid = el('div', 'grid4');
  const blind = Object.keys(d.summary)
    .filter(k => k.indexOf('blind:') === 0)
    .reduce((a, k) => a + d.summary[k], 0);
  [[t('Images labelled'), blind],
   [t('Marked as polyp'), d.summary['blind:polyp'] || 0],
   [t('Patient reviews'), (d.summary['confirm:confirm'] || 0)
      + (d.summary['confirm:retract'] || 0) + (d.summary['confirm:unsure'] || 0)],
   [t('Retired'), d.retired]].forEach(([k, v]) => {
    const c = el('div', 'stat');
    c.appendChild(el('b', '', v));
    c.appendChild(el('span', 'muted small', k));
    grid.appendChild(c);
  });
  box.appendChild(grid);

  // Yes-rate per group. This is the table that says whether a reader was
  // reading or clicking: agreed positives should mostly be yes, quiet controls
  // almost never.
  const tb = el('table');
  const hr = el('tr');
  [t('Group'), t('Labelled'), t('Said polyp')].forEach((x, i) =>
    hr.appendChild(el('th', i ? 'num' : '', x)));
  tb.appendChild(el('thead')).appendChild(hr);
  const body = el('tbody');
  Object.keys(d.by_bucket).sort().forEach(b => {
    const r = d.by_bucket[b];
    const tr = el('tr');
    tr.appendChild(el('td', '', t(BUCKET[b] || b)));
    tr.appendChild(el('td', 'num', r.n));
    tr.appendChild(el('td', 'num', r.yes + ' (' +
      Math.round(100 * r.yes / Math.max(1, r.n)) + '%)'));
    body.appendChild(tr);
  });
  tb.appendChild(body);
  box.appendChild(tb);

  const anyLive = blind > 0 || d.retired === 0;
  $('readerRetire').textContent = anyLive
    ? t('Retire all of this reader\'s feedback')
    : t('Restore this reader\'s feedback');
  $('readerRetire').onclick = async () => {
    const action = anyLive ? 'retire' : 'restore';
    if (!confirm(t(action === 'retire'
      ? 'Take every answer by this reader out of the data? Nothing is deleted — it can be restored.'
      : 'Put this reader\'s answers back into the data?'))) return;
    const r = await post('/admin/users/' + uid + '/annotations', {action: action});
    alert(t('{n} answers updated.', {n: r.affected}));
    openReader(uid);
    renderAdmin();
  };

  const rows = $('readerRows');
  rows.textContent = '';
  const t2 = el('table');
  const h2 = el('tr');
  [t('When'), '', t('Case'), t('Group'), t('Answer'), t('Seconds')]
    .forEach((x, i) => h2.appendChild(el('th', i === 5 ? 'num' : '', x)));
  t2.appendChild(el('thead')).appendChild(h2);
  const b2 = el('tbody');
  d.annotations.forEach(a => {
    const tr = el('tr');
    if (a.superseded) tr.className = 'dim';
    tr.appendChild(el('td', 'small', fmtTime(a.created_at)));
    const tc = el('td');
    if (a.thumb) {
      const im = document.createElement('img');
      im.src = a.thumb; im.loading = 'lazy'; im.alt = ''; im.className = 'thumb';
      tc.appendChild(im);
    }
    tr.appendChild(tc);
    tr.appendChild(el('td', 'small', a.case_label || '—'));
    tr.appendChild(el('td', 'small', a.bucket ? t(BUCKET[a.bucket] || a.bucket) : '—'));
    const ans = [a.stage, a.verdict, a.reason].filter(Boolean).join(' · ')
      + (a.boxes && a.boxes.length ? '  ▢' + a.boxes.length : '')
      + (a.superseded ? '  (' + t('retired') + ')' : '');
    const ac = el('td', 'small');
    ac.appendChild(el('div', '', ans));
    if (a.note) ac.appendChild(el('div', 'muted small', a.note));
    tr.appendChild(ac);
    tr.appendChild(el('td', 'num small',
      a.ms_on_item ? Math.round(a.ms_on_item / 1000) : '—'));
    b2.appendChild(tr);
  });
  t2.appendChild(b2);
  rows.appendChild(t2);
  $('readerCard').scrollIntoView({behavior: 'smooth', block: 'start'});
}

$('readerClose').onclick = () => $('readerCard').classList.add('hidden');

function drawStats(s) {
  const box = $('statBox'); box.textContent = '';
  const total = Object.values(s.pool).reduce((a, b) => a + b, 0);
  const revd = Object.values(s.reviewed || {}).reduce((a, b) => a + b, 0);
  const grid = el('div', 'grid4');
  [[t('Pool'), total], [t('Images reviewed'), revd],
   [t('Confirmed false positives'), s.confirmed_fp],
   [t('Possible report misses'), s.report_misses],
   [t('Found in missed studies'), s.fn_found],
   [t('Localisations confirmed'), s.localised]].forEach(([k, v]) => {
    const d = el('div', 'stat');
    d.appendChild(el('b', '', v));
    d.appendChild(el('span', 'muted small', k));
    grid.appendChild(d);
  });
  box.appendChild(grid);

  // Per-group coverage. Every false-positive candidate has to be adjudicated
  // before the hard-negative set is complete, so this is the progress bar that
  // actually matters.
  box.appendChild(el('h3', '', t('Coverage by group')));
  const ct = el('table');
  const chr = el('tr');
  [t('Group'), t('Images'), t('Reviewed'), t('Remaining')].forEach((h, i) =>
    chr.appendChild(el('th', i ? 'num' : '', h)));
  ct.appendChild(el('thead')).appendChild(chr);
  const cb = el('tbody');
  Object.keys(s.pool).sort().forEach(b => {
    const tr = el('tr');
    tr.appendChild(el('td', '', t(BUCKET[b] || b)));
    tr.appendChild(el('td', 'num', s.pool[b]));
    tr.appendChild(el('td', 'num', (s.reviewed || {})[b] || 0));
    tr.appendChild(el('td', 'num', (s.remaining || {})[b]));
    cb.appendChild(tr);
  });
  ct.appendChild(cb);
  box.appendChild(ct);

  box.appendChild(el('h3', '', t('Reviewers')));
  const tb = el('table');
  const hr = el('tr');
  [t('User'), t('Reviewed'), t('agreed positives called'),
   t('controls called polyp'), t('median time')].forEach((h, i) => {
    hr.appendChild(el('th', i ? 'num' : '', h));
  });
  tb.appendChild(el('thead')).appendChild(hr);
  const body = el('tbody');
  (s.readers || []).forEach(r => {
    const tr = el('tr');
    tr.appendChild(el('td', '', r.display_name || r.username));
    tr.appendChild(el('td', 'num', r.reviewed || 0));
    tr.appendChild(el('td', 'num',
      r.tp_seen ? (r.tp_called || 0) + '/' + r.tp_seen : '—'));
    tr.appendChild(el('td', 'num', r.tn_called_polyp || 0));
    tr.appendChild(el('td', 'num',
      r.avg_ms ? Math.round(r.avg_ms / 1000) + 's' : '—'));
    body.appendChild(tr);
  });
  tb.appendChild(body);
  box.appendChild(tb);

  box.appendChild(el('h3', '', t('Sessions')));
  const tb2 = el('table');
  const hr2 = el('tr');
  [t('User'), t('When'), t('Status'), t('Reviewed')].forEach((h, i) => {
    hr2.appendChild(el('th', i === 3 ? 'num' : '', h));
  });
  tb2.appendChild(el('thead')).appendChild(hr2);
  const b2 = el('tbody');
  (s.sessions || []).forEach(x => {
    const tr = el('tr');
    tr.appendChild(el('td', '', x.username));
    tr.appendChild(el('td', 'small', fmtTime(x.started_at)));
    tr.appendChild(el('td', 'small', x.status));
    tr.appendChild(el('td', 'num', x.done + '/' + x.total));
    b2.appendChild(tr);
  });
  tb2.appendChild(b2);
  box.appendChild(tb2);
}

function drawAudit(rows) {
  const box = $('auditBox'); box.textContent = '';
  const wrap = el('div', 'logbox');
  const tb = el('table');
  const hr = el('tr');
  [t('When'), t('User'), t('Action'), t('Detail')].forEach(h =>
    hr.appendChild(el('th', '', h)));
  tb.appendChild(el('thead')).appendChild(hr);
  const body = el('tbody');
  rows.forEach(r => {
    const tr = el('tr');
    tr.appendChild(el('td', 'small', fmtTime(r.ts)));
    tr.appendChild(el('td', 'small', r.username || '—'));
    tr.appendChild(el('td', 'small', r.action));
    tr.appendChild(el('td', 'small muted',
      [r.object, r.detail, r.ip].filter(Boolean).join(' · ')));
    body.appendChild(tr);
  });
  tb.appendChild(body);
  wrap.appendChild(tb);
  box.appendChild(wrap);
}

$('exportGo').onclick = () => { window.location = API + '/admin/export'; };

/* ------------------------------------------------------------------- boot */
$('langBtn').onclick = () => { LANG = LANG === 'fa' ? 'en' : 'fa'; applyLang(); };

(async function boot() {
  captureFarsi();
  applyLang();
  try {
    const me = await api('/me');
    state.me = me; state.csrf = me.csrf;
    afterAuth();
  } catch (e) {
    show('login');
  }
})();
