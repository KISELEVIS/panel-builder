/* =========================================================================
   Щит.Студия — прототип конфигуратора электрического щита
   -------------------------------------------------------------------------
   Почему SVG, а не HTML5 Canvas:
   - модули и провода остаются обычными DOM/SVG-элементами, поэтому у них
     нативно работают клики, клавиатурный фокус, title/aria-атрибуты и CSS;
   - не нужен ручной hit-testing для проводов;
   - SVG масштабируется без потери качества и остаётся чётким на Retina.
   Координаты указателя переводятся в систему координат холста через
   getScreenCTM().inverse() — offsetX/offsetY не
   используются.
   ========================================================================= */

/* --------------------------- Supabase (глобально) ----------------------
   Клиент создаётся ОДИН раз и доступен глобально (в том числе как
   window.supabaseClient).
   createClient вызывается через window.supabase — глобал из CDN, подключённого
   в index.html ДО этого скрипта. Глобальную переменную объявляем через var:
   CDN уже создал global var supabase, и повторное const/let выбросило бы
   SyntaxError и убило весь скрипт.
   Если библиотека не загрузилась (например, нет интернета), supabase будет null
   и приложение продолжит работать локально. */
if (!window.fetch) {
  console.warn('Внимание: fetch не поддерживается в этом браузере');
}

const supabaseUrl = 'https://sqtmnjxauskzyfnvfcpx.supabase.co';
const supabaseKey = 'sb_publishable_R3a6uqxbP9rQAaJrcnyqXA_A00D0U0O';
// var (а не const/let) использован намеренно: CDN-библиотека уже объявляет
// глобальную var supabase, и повторное const вызвало бы SyntaxError и убило
// весь скрипт. Повторная декларация var просто перезаписывает глобал клиентом.
var supabase = window.supabase && typeof window.supabase.createClient === 'function'
  ? window.supabase.createClient(supabaseUrl, supabaseKey)
  : null;
window.supabaseClient = supabase;

(() => {
  'use strict';

  /* ----------------------- Облако (Supabase) ---------------------------
     Клиент уже создан в глобальной области (см. начало файла). Если CDN не
     загрузился, supabase === null: облачные кнопки неактивны, приложение
     продолжает работать локально. */
  if (!supabase) {
    console.error('[Щит.Студия] Не удалось инициализировать Supabase: библиотека @supabase/supabase-js не загружена');
  }

  // Текущий пользователь Supabase. Пока он не задан, облачные кнопки
  // неактивны, а все запросы к таблице projects идут через RLS.
  let currentUser = null;
  let cloudBusy = false;

  /* ----------------------------- Constants ----------------------------- */

  // Ключ намеренно остаётся прежним: так старые проекты находятся и мигрируют.
  const STORAGE_KEY = 'panel-builder.project.v1';
  // v5: модули привязаны к слотам (slot) вместо порядкового номера (order).
  // Старые проекты с order конвертируются в slot при загрузке.
  // v6: добавлены мощность нагрузки (power) и отображение параметров сети
  // (showParams: напряжение / ток / мощность).
  const SCHEMA_VERSION = 6;
  // Ровно три переключаемых слоя холста. Порядок массива совпадает с порядком
  // групп <g> в SVG (сверху вниз по DOM): провода → модули → подписи. Именно
  // он задаёт z-index на холсте. Порты НЕ являются слоем: они рендерятся
  // внутри модулей (#layer-modules) в локальных координатах модуля и потому
  // гарантированно исчезают вместе с ним. Порты источника живут в его группе.
  const LAYER_KEYS = ['wires', 'modules', 'labels'];
  const LAYER_ELEMENT_IDS = {
    wires: 'layer-wires',
    modules: 'layer-modules',
    labels: 'layer-labels'
  };
  const LAYER_NAMES = {
    wires: 'Провода',
    modules: 'Модули',
    labels: 'Подписи'
  };
  // Соответствие ключа слоя полю в dom — используется при создании структур.
  const LAYER_DOM_FIELDS = {
    wires: 'wireLayer',
    modules: 'moduleLayer',
    labels: 'labelLayer'
  };
  // Непереключаемые группы: фон DIN-реек и закреплённый источник питания.
  // У них нет тумблеров в панели «Слои», они не получают классы .hidden/.locked
  // и потому всегда видны, независимо от состояния слоёв модулей и проводов.
  const STATIC_GROUP_IDS = Object.freeze(['rail-track', 'layer-power-source']);
  const STATIC_GROUP_LAYER_ID = 'layer-power-source';
  const STATIC_GROUP_RAIL_ID = 'rail-track';
  // Текстовые заметки (стикеры) живут в собственной группе поверх всех слоёв.
  // У неё нет тумблера в панели «Слои»: заметки всегда видны и не блокируются.
  const NOTES_GROUP_ID = 'layer-notes';
  // Номинальное фазное напряжение и пределы мощности нагрузки.
  const NOMINAL_VOLTAGE = 230;
  const DEFAULT_LOAD_POWER = 1000;
  const MIN_LOAD_POWER = 1;
  const MAX_LOAD_POWER = 100000;
  // История живёт только в памяти: в localStorage пишется лишь текущий проект.
  const HISTORY_LIMIT = 50;
  // Пределы длины пользовательских подписей (описание модуля / маркировка провода).
  const MAX_MODULE_DESCRIPTION_LENGTH = 200;
  // Название модуля сохраняется в проекте и попадает в спецификацию; лимит
  // совпадает с normalizeModules(), иначе длинное имя обрезалось бы при загрузке.
  const MAX_MODULE_NAME_LENGTH = 40;
  const MAX_WIRE_LABEL_LENGTH = 80;
  // Примечание в кабельном журнале: то же поле connection.label, что и подпись
  // провода на схеме. 50 символов достаточно и не ломают ширину колонки.
  const MAX_JOURNAL_NOTE_LENGTH = 50;
  /* -------------------------- Маркировка (1:1) --------------------------
     Все числа здесь — миллиметры. Ширина одного модуля DIN равна 18 мм,
     поэтому наклейка на 1P имеет ровно 18 мм и т. д. Высота наклейки
     12 мм (20 мм при вертикальной надписи), бирка провода — 24 × 8 мм.
     Шаблон листа задаётся в @page, который генерируется из настроек. */
  const MM_PER_MODULE = 18;
  // Компактная горизонтальная наклейка листа 1:1: 14 мм в высоту и зазор 1 мм
  // между наклейками — плотный поток, максимум наклеек на листе A4.
  const PRINT_STICKER_HEIGHT_MM = 14;
  const PRINT_STICKER_GAP_MM = 1;
  const MARKING_STICKER_HEIGHT_MM = 12;
  const MARKING_STICKER_VERTICAL_HEIGHT_MM = 20;
  const MARKING_WIRE_WIDTH_MM = 24;
  const MARKING_WIRE_HEIGHT_MM = 8;
  // Высота компактной печатной бирки провода на листе 1:1.
  const PRINT_WIRE_STICKER_HEIGHT_MM = 12;
  const MARKING_GAP_X_MM = 2;
  const MARKING_GAP_Y_MM = 2;
  // Редактор ленты: каждая рейка — отдельный горизонтальный ряд. Зазор между
  // рядами оставляет место для разрезания наклеек после печати.
  const TAPE_RAIL_GAP_MM = 12;
  const TAPE_CELL_HEIGHT_MM = 44;
  const TAPE_RAIL_HEADING_MM = 9;
  // Печатный лист 1:1: у каждой рейки свой ряд (заголовок + полоса наклеек).
  const SHEET_RAIL_HEADING_MM = 7;
  const SHEET_RAIL_GAP_MM = 5;
  const MARKING_RULER_HEIGHT_MM = 11;
  // Контрольный маркер 100 мм внизу листа и блок «Легенда» над ним.
  // Высота легенды считается по числу уникальных значков (2 колонки).
  const MARKING_SCALE_MARKER_HEIGHT_MM = 17;
  const MARKING_LEGEND_HEADER_MM = 7;
  const MARKING_LEGEND_ROW_MM = 6;
  const MARKING_LEGEND_COLUMNS = 2;
  const MARKING_MAIN_LENGTH = 80;
  const MARKING_SHEET_SIZES = Object.freeze({
    A4: { portrait: [210, 297], landscape: [297, 210] },
    A5: { portrait: [148, 210], landscape: [210, 148] }
  });
  const DEFAULT_MARKING_SETTINGS = Object.freeze({
    sheet: 'A4',
    orientation: 'portrait',
    marginTop: 12,
    marginRight: 12,
    marginBottom: 12,
    marginLeft: 12,
    showRuler: true,
    printLegend: false
  });
  // Пиктограммы на фоне наклейки. Ключ хранится в marking.icon.
  const MARKING_ICONS = Object.freeze({
    none: { label: 'Без пиктограммы', svg: '' },
    light: {
      label: 'Свет',
      svg: '<path d="M8 13.5a4 4 0 1 1 8 0c0 1.6-1 2.4-1.6 3.2H9.6C9 15.9 8 15.1 8 13.5Z"/><path d="M10 19h4M10.8 21h2.4"/>'
    },
    socket: {
      label: 'Розетка',
      svg: '<circle cx="12" cy="12" r="8"/><path d="M9.5 10v3M14.5 10v3M12 15.5h.01"/>'
    },
    aircon: {
      label: 'Кондиционер',
      svg: '<rect x="3" y="5" width="18" height="7" rx="2"/><path d="M6 8.5h12M7 16c1.2 1.2 2.5 1.2 3.7 0M12.5 16c1.2 1.2 2.5 1.2 3.7 0"/>'
    },
    switch: {
      label: 'Выключатель',
      svg: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 14c1.6-3 4.4-3 6-5"/>'
    },
    breaker: {
      label: 'Автомат',
      svg: '<rect x="6" y="4" width="12" height="16" rx="2"/><path d="M12 16V9M9.5 9h5"/>'
    },
    vent: {
      label: 'Вентиляция',
      svg: '<circle cx="12" cy="12" r="8"/><path d="M12 12c0-3 3-4 4.5-2.5M12 12c3 0 4 3 2.5 4.5M12 12c0 3-3 4-4.5 2.5M12 12c-3 0-4-3-2.5-4.5"/>'
    },
    power: {
      label: 'Питание',
      svg: '<path d="M12 3v9"/><path d="M7.2 6.7a7 7 0 1 0 9.6 0"/>'
    },
    bell: {
      label: 'Сигнал',
      svg: '<path d="M6 16h12l-1.5-2V10a4.5 4.5 0 0 0-9 0v4L6 16Z"/><path d="M10.5 19h3"/>'
    },
    computer: {
      label: 'Компьютер',
      svg: '<rect x="3" y="5" width="18" height="11" rx="2"/><path d="M8 20h8M12 16v4"/>'
    },
    kitchen: {
      label: 'Кухня',
      svg: '<path d="M4 11a8 8 0 0 0 16 0H4Z"/><path d="M3 11h18M9 7.5h.01M13 6h.01M16 8h.01"/>'
    },
    washer: {
      label: 'Стиральная машина',
      svg: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="4"/><path d="M7 6h.01M10 6h.01"/>'
    },
    boiler: {
      label: 'Водонагрев',
      svg: '<rect x="6" y="4" width="12" height="17" rx="3"/><path d="M9 8h6M12 17c1.2-1.2 2-2.2 2-3.2a2 2 0 1 0-4 0c0 1 .8 2 2 3.2Z"/>'
    },
    tv: {
      label: 'Телевизор',
      svg: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 20h8M12 17v3"/>'
    },
    fridge: {
      label: 'Холодильник',
      svg: '<rect x="6" y="2.5" width="12" height="19" rx="2"/><path d="M6 9h12M9 5.5v2M9 12v3"/>'
    }
  });
  // Цвета цветовой полосы наклейки (фазы / линии / назначение).
  const MARKING_TAPE_COLORS = Object.freeze([
    { value: '#22c55e', label: 'Зелёный' },
    { value: '#ef4444', label: 'Красный' },
    { value: '#3b82f6', label: 'Синий' },
    { value: '#f59e0b', label: 'Жёлтый' },
    { value: '#8b5cf6', label: 'Фиолетовый' },
    { value: '#111827', label: 'Чёрный' }
  ]);
  const DEFAULT_TAPE_COLOR = MARKING_TAPE_COLORS[0].value;
  // Стикеры: текст, габариты и число строк, помещающихся на бумажке.
  const MAX_NOTE_TEXT_LENGTH = 500;
  const NOTE_WIDTH = 176;
  const NOTE_HEIGHT = 132;
  const NOTE_TEXT_MAX_CHARS = 22;
  const NOTE_TEXT_MAX_LINES = 5;
  const NOTE_LINE_HEIGHT = 18;

  const SVG_WIDTH = 1016;
  const SVG_BASE_HEIGHT = 520;
  // Пределы масштабирования и шаг кнопок +/- (колесико работает плавно).
  // Минимум 0.2 (20%): при сильном отдалении viewBox остаётся конечным,
  // координаты не превращаются в NaN/Infinity, а фон-ловушка мыши
  // (canvas-hit-area) продолжает покрывать всю видимую область.
  const VIEW_ZOOM_MIN = 0.2;
  const VIEW_ZOOM_MAX = 5;
  const VIEW_ZOOM_STEP = 1.25;
  const MODULE_UNIT = 48;
  const MODULE_HEIGHT = 160;
  // Реальная ширина одного модуля DIN-рейки — 18 мм. Отсюда масштаб схемы:
  // 48 px = 0.018 м, то есть ~2666.7 px на метр. Длины считаются в
  // координатах viewBox, поэтому зум и панорамирование на них не влияют.
  const MODULE_REAL_WIDTH_METERS = 0.018;
  const PIXELS_PER_METER = MODULE_UNIT / MODULE_REAL_WIDTH_METERS;
  // Технологический запас на изгибы, укладку и разделку концов провода.
  const WIRE_LENGTH_RESERVE = 1.25;
  // Смета: цена одного метра проводника (L1, L2, L3, N, PE), руб/м.
  const WIRE_PRICE_PER_METER = 50;
  // Предел для введённой вручную цены: защищает от «случайного» Number.MAX_VALUE
  // в localStorage и от некорректных чисел в импортированном JSON.
  const MAX_CUSTOM_PRICE = 100000000;
  // Резервные цены для старых элементов библиотеки, у которых в library.js
  // нет поля price. Новые позиции всегда берут цену оттуда.
  const DEFAULT_PRICE_BY_TYPE = Object.freeze({
    breaker: 350,
    rcbo: 1500,
    rcd: 1200,
    contactor: 850,
    relay: 950,
    timer: 1250,
    'impulse-relay': 450,
    'power-supply': 1550,
    voltmeter: 680,
    meter: 2100,
    terminal: 60,
    busbar: 300,
    load: 0
  });
  // Отступы вокруг холста и коэффициент чёткости для PNG-экспорта.
  const EXPORT_PADDING = 24;
  const EXPORT_SCALE = 2;
  // Дополнительный запас сверх габарита элементов (в единицах viewBox),
  // чтобы тени и подписи не прилипали к краю PNG.
  const EXPORT_BBOX_MARGIN = 12;

  const RAIL = Object.freeze({
    x: 50,
    y: 200,
    width: 916,
    height: 266,
    capacity: 18,
    // startX — левая граница сетки слотов. X модуля = startX + slot * MODULE_UNIT.
    startX: 74,
    moduleX: 74,
    moduleY: 250,
    moduleRight: 938
  });
  // Рейки стоят вертикально друг под другом; шаг включает запас на провода.
  const RAIL_GAP = 100;
  const RAIL_PITCH = RAIL.height + RAIL_GAP;
  const MAX_RAILS = 8;
  // Вместимость рейки меняется кнопками [-]/[+] с шагом 1 модуль.
  const MIN_RAIL_CAPACITY = 1;
  const MAX_RAIL_CAPACITY = 24;
  const RAIL_CAPACITY_STEP = 1;
  // Рейка рисуется не фиксированной ширины, а по числу посадочных мест:
  // запас слева/справа от модулей берём из эталонной геометрии RAIL.
  const RAIL_PAD_LEFT = RAIL.moduleX - RAIL.x;
  const RAIL_PAD_RIGHT = (RAIL.x + RAIL.width) - RAIL.moduleRight;
  // Вертикальные коридоры для проводов — за пределами пластины рейки.
  const CORRIDOR_LANE_GAP = 8;

  // Источник питания — отдельный блок над первой рейкой, не модуль DIN.
  // Порты снизу: L1, L2, L3, N, PE (индексы 0…4).
  const POWER_SOURCE = Object.freeze({
    id: 'power-source',
    isPowerSource: true,
    x: RAIL.moduleX,
    y: 72,
    width: 384,
    height: 96,
    label: 'Источник питания',
    caption: 'Вводной щиток · 3Ф + N + PE',
    ports: Object.freeze(['L1', 'L2', 'L3', 'N', 'PE'])
  });

  // Пять проводников трёхфазной сети. color — канонический цвет данных;
  // те же значения продублированы CSS-переменными --wire-l1…--wire-pe.
  const WIRE_TYPES = Object.freeze({
    L1: { label: 'L1', name: 'Фаза L1', color: '#8b4513' },
    L2: { label: 'L2', name: 'Фаза L2', color: '#333333' },
    L3: { label: 'L3', name: 'Фаза L3', color: '#808080' },
    N: { label: 'N', name: 'Ноль', color: '#3b82f6' },
    PE: { label: 'PE', name: 'Земля', color: '#22c55e' }
  });
  const WIRE_TYPE_KEYS = Object.freeze(Object.keys(WIRE_TYPES));
  const DEFAULT_WIRE_TYPE = 'L1';
  // Старые проекты хранили единственную фазу как L; переводим её в L1.
  const LEGACY_WIRE_TYPES = Object.freeze({ L: 'L1' });
  const LEGACY_WIRE_COLORS = Object.freeze({
    '#f59e0b': 'L1',
    '#9a4f1f': 'L1',
    '#a3e635': 'PE'
  });

  /* Визуальные карты. Данные проекта (включая WIRE_TYPES и connection.color)
     остаются прежними — здесь задаётся только то, как всё рисуется. */
  const WIRE_DISPLAY_COLORS = Object.freeze({
    L1: '#8b4513',
    L2: '#333333',
    L3: '#808080',
    N: '#3b82f6',
    PE: '#22c55e'
  });
  const MODULE_BODY_VARIANTS = Object.freeze({
    rcd: 'light',
    rcbo: 'light',
    contactor: 'dark',
    relay: 'dark',
    'impulse-relay': 'dark',
    timer: 'dark',
    'power-supply': 'dark',
    meter: 'dark',
    voltmeter: 'dark',
    terminal: 'terminal',
    busbar: 'terminal'
  });
  const MODULE_BRANDS = Object.freeze({
    breaker: 'ELECTRA',
    rcbo: 'ELECTRA',
    rcd: 'DIFFPRO',
    contactor: 'CONTACT',
    relay: 'RELPRO',
    'impulse-relay': 'PULSE',
    timer: 'TIMEON',
    'power-supply': 'POWER',
    voltmeter: 'MEASURE',
    meter: 'METER',
    terminal: 'TERMINAL',
    busbar: 'BUS',
    load: 'POWER'
  });
  // Только эти модули имеют коммутационную способность и получают рычажок.
  const SWITCHABLE_MODULE_TYPES = Object.freeze(new Set([
    'breaker',
    'rcbo',
    'rcd',
    'contactor',
    'relay',
    'impulse-relay'
  ]));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PORT_LABELS = Object.freeze({
    top: 'верх', bottom: 'низ', left: 'лево', right: 'право'
  });
  // Полный список граней: обычные модули используют только top/bottom,
  // боковые шины N/PE — только left/right. Порядок важен для стабильности
  // обхода (рендер, фазировка, симуляция).
  const PORT_SIDES = Object.freeze(['top', 'right', 'bottom', 'left']);
  const VERTICAL_PORT_SIDES = Object.freeze(['top', 'bottom']);
  const SIDE_PORT_SIDES = Object.freeze(['left', 'right']);
  const PORT_RADIUS = 4;
  // Клеммы боковых шин идут вплотную (10 штук на высоте модуля), поэтому
  // видимая точка меньше, а зона захвата уже — иначе круги перекрывали бы
  // друг друга и клик попадал не в тот порт.
  const SIDE_PORT_RADIUS = 3;
  const PORT_HIT_RADIUS = 11;
  const SIDE_PORT_HIT_RADIUS = 6;
  const WIRE_OFFSET = 30;
  const WIRE_LANE_GAP = 8;
  // Горизонтальный «вывод» боковой клеммы: короткий отрезок от грани
  // модуля, после которого провод уходит вверх/вниз по ряду над модулями.
  const WIRE_STUB = 14;
  // Вертикальные коридоры для проводов, идущих с верхней грани на нижнюю.
  const WIRE_CORRIDOR_X = Object.freeze({ left: 40, right: 976 });
  const MIGRATION_NOTICE = 'Провода сброшены из-за обновления, проведите заново';

  // Fallback palette for unknown legacy modules; new modules use LIBRARY colors.
  const WIRE_COLORS = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635'];
  const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

  /* --------------------- Библиотека из library.js ----------------------
     Все элементы задаются в window.ELECTRIC_LIBRARY (файл library.js).
     Здесь данные только проверяются и приводятся к безопасному виду.
     Категории НЕ захардкожены: они собираются из поля category, поэтому
     достаточно добавить в library.js элемент с новой категорией — группа
     появится в левой панели автоматически.
  --------------------------------------------------------------------- */
  const LIBRARY_SOURCE = Array.isArray(window.ELECTRIC_LIBRARY) ? window.ELECTRIC_LIBRARY : [];

  if (!Array.isArray(window.ELECTRIC_LIBRARY)) {
    console.warn('[Щит.Студия] window.ELECTRIC_LIBRARY не найден. Подключите library.js перед script.js.');
  }

  function normalizeLibraryEntry(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const text = (value, fallback, maxLength) => {
      if (typeof value !== 'string') return fallback;
      const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
      return cleaned || fallback;
    };
    const portCount = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.min(10, Math.max(0, Math.round(parsed))) : 0;
    };

    const id = text(raw.id, '', 80);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      console.warn(`[Щит.Студия] Элемент библиотеки №${index + 1} пропущен: некорректный id.`, raw);
      return null;
    }

    const widthValue = Number(raw.width);
    const width = Number.isFinite(widthValue) ? Math.min(24, Math.max(1, Math.round(widthValue))) : 1;
    const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)
      ? raw.color.toLowerCase()
      : '#3b82f6';
    const rawPorts = raw.ports && typeof raw.ports === 'object' ? raw.ports : {};
    const busType = raw.busType === 'N' || raw.busType === 'PE'
      ? raw.busType
      : (raw.busbarType === 'N' || raw.busbarType === 'PE' ? raw.busbarType : null);
    const type = text(raw.type, 'other', 24);
    const priceValue = Number(raw.price);
    const price = Number.isFinite(priceValue) && priceValue >= 0 ? priceValue : null;

    return {
      id,
      category: text(raw.category, 'Разное', 60),
      name: text(raw.name, id, 60),
      type,
      typeLabel: text(raw.typeLabel, type, 40),
      width,
      color,
      tagPrefix: text(raw.tagPrefix, 'M', 10),
      ports: {
        top: portCount(rawPorts.top),
        right: portCount(rawPorts.right),
        bottom: portCount(rawPorts.bottom),
        left: portCount(rawPorts.left)
      },
      isBusbar: raw.isBusbar === true || busType !== null,
      busType,
      busbarType: busType,
      brand: text(raw.brand, '', 60),
      sku: text(raw.sku, '', 60),
      // Цена из library.js. null = в базе не задана, тогда смета берёт
      // резервное значение по типу модуля.
      price,
      power: normalizeLoadPower(raw.power, DEFAULT_LOAD_POWER),
      description: text(raw.description, '', 600)
    };
  }

  const seenLibraryIds = new Set();
  const LIBRARY = Object.freeze(
    LIBRARY_SOURCE.map(normalizeLibraryEntry).filter((item) => {
      if (!item || seenLibraryIds.has(item.id)) return false;
      seenLibraryIds.add(item.id);
      return true;
    })
  );

  // Категории формируются автоматически из поля category каждого элемента.
  // Порядок групп соответствует порядку первого появления категории.
  const LIBRARY_CATEGORIES = Object.freeze(
    LIBRARY.length > 0
      ? [...new Set(LIBRARY.map((item) => item.category))].map((label) => ({ id: label, label }))
      : [{ id: 'Разное', label: 'Разное' }]
  );

  const LIBRARY_BY_ID = new Map(LIBRARY.map((item) => [item.id, item]));
  const LIBRARY_ORDER = new Map(LIBRARY.map((item, index) => [item.id, index]));
  const LIBRARY_CATEGORY_BY_ID = new Map(LIBRARY_CATEGORIES.map((category) => [category.id, category]));
  const LEGACY_TYPE_LABELS = Object.freeze({
    breaker: 'Автомат',
    rcbo: 'Дифавтомат',
    rcd: 'УЗО',
    contactor: 'Контактор',
    relay: 'Реле',
    timer: 'Таймер',
    'impulse-relay': 'Импульсное реле',
    'power-supply': 'Блок питания',
    voltmeter: 'Вольтметр',
    meter: 'Счётчик',
    terminal: 'Клеммы',
    busbar: 'Шинный',
    load: 'Нагрузка'
  });

  /* ------------------------------- DOM -------------------------------- */

  const dom = {
    libraryList: document.getElementById('library-list'),
    libraryCount: document.getElementById('library-count'),
    librarySearch: document.getElementById('library-search'),
    librarySearchClear: document.getElementById('library-search-clear'),
    librarySearchStatus: document.getElementById('library-search-status'),
    libraryNoResults: document.getElementById('library-no-results'),
    projectName: document.getElementById('project-name'),
    saveState: document.getElementById('save-state'),
    saveText: document.getElementById('save-text'),
    undoBtn: document.getElementById('undo-btn'),
    redoBtn: document.getElementById('redo-btn'),
    // Склейка модулей.
    groupBtn: document.getElementById('group-modules'),
    ungroupBtn: document.getElementById('ungroup-modules'),
    exportCsv: document.getElementById('export-csv'),
    exportCsvSecondary: document.getElementById('export-csv-secondary'),
    exportPng: document.getElementById('export-png'),
    downloadProject: document.getElementById('download-project'),
    documentsDropdown: document.getElementById('documents-dropdown'),
    documentsMenuBtn: document.getElementById('documents-menu-btn'),
    documentsMenu: document.getElementById('documents-menu'),
    exportDropdown: document.getElementById('export-dropdown'),
    exportMenuBtn: document.getElementById('export-menu-btn'),
    exportMenu: document.getElementById('export-menu'),
    importProject: document.getElementById('import-project'),
    importFile: document.getElementById('import-file'),
    openJournal: document.getElementById('open-journal'),
    zoomInBtn: document.getElementById('zoom-in'),
    zoomOutBtn: document.getElementById('zoom-out'),
    zoomLevel: document.getElementById('zoom-level'),
    resetViewBtn: document.getElementById('reset-view'),
    simulationToggle: document.getElementById('simulation-toggle'),
    simulationState: document.getElementById('simulation-state'),
    paramsToggle: document.getElementById('params-toggle'),
    paramsState: document.getElementById('params-state'),
    elementTooltip: document.getElementById('element-tooltip'),
    clearProject: document.getElementById('clear-project'),
    canvasShell: document.getElementById('canvas-shell'),
    canvas: document.getElementById('panel-canvas'),
    canvasSurface: document.getElementById('canvas-surface'),
    canvasGrid: document.getElementById('canvas-grid'),
    svgWrap: document.getElementById('svg-wrap'),
    // Статичные группы: рейки всегда видны, источник питания закреплён над
    // первой рейкой и не входит ни в один переключаемый слой.
    railTrack: document.getElementById(STATIC_GROUP_RAIL_ID),
    powerSourceLayer: document.getElementById(STATIC_GROUP_LAYER_ID),
    wireLayer: document.getElementById('layer-wires'),
    moduleLayer: document.getElementById('layer-modules'),
    labelLayer: document.getElementById('layer-labels'),
    // Стикеры рисуются в отдельной группе поверх подписей и проводов.
    notesLayer: document.getElementById(NOTES_GROUP_ID),
    addNoteBtn: document.getElementById('add-note'),
    layersPanel: document.getElementById('layers-panel'),
    layersToggle: document.getElementById('layers-toggle'),
    layersList: document.getElementById('layers-list'),
    selectionBox: document.getElementById('selection-box'),
    wireTypePopover: document.getElementById('wire-type-popover'),
    wireTypeCancel: document.getElementById('wire-type-cancel'),
    portTooltip: document.getElementById('port-tooltip'),
    portPhaseTooltip: document.getElementById('port-phase-tooltip'),
    migrationBanner: document.getElementById('migration-banner'),
    migrationBannerClose: document.getElementById('migration-banner-close'),
    emptyState: document.getElementById('empty-state'),
    railAlert: document.getElementById('rail-alert'),
    railAlertText: document.getElementById('rail-alert-text'),
    addRail: document.getElementById('add-rail'),
    railMeter: document.getElementById('rail-meter'),
    railUsage: document.getElementById('rail-usage'),
    railProgress: document.getElementById('rail-progress'),
    railFill: document.getElementById('rail-fill'),
    railFree: document.getElementById('rail-free'),
    connectionHint: document.getElementById('connection-hint'),
    cancelConnect: document.getElementById('cancel-connect'),
    specBody: document.getElementById('spec-body'),
    specFoot: document.getElementById('spec-foot'),
    specTotal: document.getElementById('spec-total'),
    specMeta: document.getElementById('spec-meta'),
    specConnectionsTotal: document.getElementById('spec-connections-total'),
    specRailsTotal: document.getElementById('spec-rails-total'),
    specModulesTotal: document.getElementById('spec-modules-total'),
    specWireL1: document.getElementById('spec-wire-l1'),
    specWireL2: document.getElementById('spec-wire-l2'),
    specWireL3: document.getElementById('spec-wire-l3'),
    specWireN: document.getElementById('spec-wire-n'),
    specWirePE: document.getElementById('spec-wire-pe'),
    specCable: document.getElementById('spec-cable'),
    specCableL1: document.getElementById('spec-cable-l1'),
    specCableL2: document.getElementById('spec-cable-l2'),
    specCableL3: document.getElementById('spec-cable-l3'),
    specCableN: document.getElementById('spec-cable-n'),
    specCablePE: document.getElementById('spec-cable-pe'),
    connectionsCount: document.getElementById('connections-count'),
    connectionList: document.getElementById('connection-list'),
    clearDialog: document.getElementById('clear-dialog'),
    inlineEditor: document.getElementById('inline-editor'),
    openEstimate: document.getElementById('open-estimate'),
    estimateDialog: document.getElementById('estimate-dialog'),
    estimateClose: document.getElementById('estimate-close'),
    estimateCloseBottom: document.getElementById('estimate-close-bottom'),
    estimateSubtitle: document.getElementById('estimate-subtitle'),
    estimateBody: document.getElementById('estimate-body'),
    estimateContent: document.getElementById('estimate-content'),
    estimateDownloadCsv: document.getElementById('estimate-download-csv'),
    estimatePrint: document.getElementById('estimate-print'),
    estimatePrintSheet: document.getElementById('estimate-print-sheet'),
    // Полный печатный документ «Весь проект в PDF».
    fullPdfBtn: document.getElementById('full-project-pdf'),
    fullPrintView: document.getElementById('full-print-view'),
    // Вкладки рабочей области и кабельный журнал.
    viewTabs: document.getElementById('view-tabs'),
    tabSchema: document.getElementById('tab-schema'),
    tabJournal: document.getElementById('tab-journal'),
    schemaView: document.getElementById('schema-view'),
    journalView: document.getElementById('journal-view'),
    journalSubtitle: document.getElementById('journal-subtitle'),
    journalBody: document.getElementById('journal-body'),
    journalFoot: document.getElementById('journal-foot'),
    journalTotalCount: document.getElementById('journal-total-count'),
    journalTotalLength: document.getElementById('journal-total-length'),
    journalDownloadCsv: document.getElementById('journal-download-csv'),
    journalPrint: document.getElementById('journal-print'),
    journalPrintSheet: document.getElementById('journal-print-sheet'),
    // Вкладка «Маркировка».
    openMarking: document.getElementById('open-marking'),
    tabMarking: document.getElementById('tab-marking'),
    markingView: document.getElementById('marking-view'),
    markingSubtitle: document.getElementById('marking-subtitle'),
    markingToolsList: document.getElementById('marking-tools-list'),
    markingToolHint: document.getElementById('marking-tool-hint'),
    markingToolClear: document.getElementById('marking-tool-clear'),
    markingTape: document.getElementById('marking-tape'),
    markingTapeViewport: document.getElementById('marking-tape-viewport'),
    markingTapePrint: document.getElementById('marking-tape-print'),
    markingSheetFold: document.getElementById('marking-sheet-fold'),
    tapePropsEmpty: document.getElementById('marking-props-empty'),
    tapePropsBody: document.getElementById('marking-props-body'),
    tapePropsTarget: document.getElementById('marking-props-target'),
    tapeTagInput: document.getElementById('tape-tag-input'),
    tapeDescInput: document.getElementById('tape-desc-input'),
    tapeIconPicker: document.getElementById('tape-icon-picker'),
    tapeColorSwatches: document.getElementById('tape-color-swatches'),
    tapeColorCustom: document.getElementById('tape-color-custom'),
    tapeMergeCheck: document.getElementById('tape-merge-check'),
    tapePropsMeta: document.getElementById('tape-props-meta'),
    tapeResetCell: document.getElementById('tape-reset-cell'),
    markingDownload: document.getElementById('marking-download'),
    markingSheetArea: document.getElementById('marking-sheet-area'),
    markingSheetWrap: document.getElementById('marking-sheet-wrap'),
    markingPrintSheet: document.getElementById('marking-print-sheet'),
    markingPageStyle: document.getElementById('marking-page-style'),
    markingAutonumber: document.getElementById('marking-autonumber'),
    markingExportJson: document.getElementById('marking-export-json'),
    markingPrint: document.getElementById('marking-print'),
    markingPdf: document.getElementById('marking-pdf'),
    markingReset: document.getElementById('marking-reset'),
    markingSize: document.getElementById('marking-sheet-size'),
    markingOrientation: document.getElementById('marking-orientation'),
    markingMarginTop: document.getElementById('marking-margin-top'),
    markingMarginRight: document.getElementById('marking-margin-right'),
    markingMarginBottom: document.getElementById('marking-margin-bottom'),
    markingMarginLeft: document.getElementById('marking-margin-left'),
    markingRulerToggle: document.getElementById('marking-ruler-toggle-input'),
    markingRulerState: document.getElementById('marking-ruler-state'),
    markingPrintLegend: document.getElementById('marking-print-legend'),
    markingPrintLegendState: document.getElementById('marking-print-legend-state'),
    markingEditor: document.getElementById('marking-editor'),
    markingEditorTitle: document.getElementById('marking-editor-title'),
    markingEditorClose: document.getElementById('marking-editor-close'),
    markingMainInput: document.getElementById('marking-main-input'),
    markingTextMode: document.getElementById('marking-text-mode'),
    markingTextOrientation: document.getElementById('marking-text-orientation'),
    markingWidthMm: document.getElementById('marking-width-mm'),
    markingPreset: document.getElementById('marking-preset'),
    markingIconPicker: document.getElementById('marking-icon-picker'),
    markingEditorMeta: document.getElementById('marking-editor-meta'),
    markingClone: document.getElementById('marking-clone'),
    markingGroup: document.getElementById('marking-group'),
    markingDelete: document.getElementById('marking-delete'),
    toastRegion: document.getElementById('toast-region'),
    // Облачные проекты (Supabase): кнопки в шапке и диалог выбора.
    cloudSave: document.getElementById('cloud-save'),
    cloudLoad: document.getElementById('cloud-load'),
    cloudDialog: document.getElementById('cloud-dialog'),
    cloudDialogList: document.getElementById('cloud-project-list'),
    cloudDialogClose: document.getElementById('cloud-dialog-close'),
    cloudDialogCancel: document.getElementById('cloud-dialog-cancel'),
    // Авторизация (Supabase Auth).
    authBlock: document.getElementById('auth-block'),
    authEmail: document.getElementById('auth-email'),
    authLogin: document.getElementById('auth-login'),
    authLogout: document.getElementById('auth-logout'),
    authDialog: document.getElementById('auth-dialog'),
    authForm: document.getElementById('auth-form'),
    authEmailInput: document.getElementById('auth-email-input'),
    authPasswordInput: document.getElementById('auth-password-input'),
    authError: document.getElementById('auth-error'),
    authSigninBtn: document.getElementById('auth-signin-btn'),
    authSignupBtn: document.getElementById('auth-signup-btn'),
    // Контекстное меню (ПКМ) — живёт на уровне body, position: fixed.
    contextMenu: document.getElementById('context-menu'),
    contextMenuHead: document.getElementById('context-menu-head'),
    contextMenuItems: document.getElementById('context-menu-items')
  };

  /* ------------------------------ State ------------------------------- */

  let project = null;
  // Активная вкладка рабочей области: 'schema' | 'journal'.
  let activeTab = 'schema';
  // Что печатать: по умолчанию кабельный журнал, кнопки сметы/маркировки
  // переключают вывод на соответствующий печатный лист.
  let printContext = 'journal';
  // Маркировка: выбранная наклейка, якорь всплывающего редактора и буфер.
  let selectedMarkingId = null;
  let markingEditorAnchor = null; // { type: 'sticker' | 'module', id }
  let markingClipboard = null;    // копия наклейки для Ctrl+C / Ctrl+V
  // Редактор ленты: выбранная ячейка, отложенный значок и активный режим.
  let selectedTapeMarkingId = null;
  let tapePendingIcon = null;
  let markingMode = 'tape'; // 'tape' | 'sheet'
  // Редактируемая подпись: { kind: 'module' | 'wire', id, anchorRect }.
  let editing = null;
  // Глобальная привязка открытого inline-поля к конкретному элементу холста.
  // Используется горячими клавишами и обработчиками жестов, чтобы не дать
  // Delete/зуму/панораме «проехаться» по элементу, пока идёт ввод.
  let currentEditingId = null;
  let currentEditingType = null; // 'module' | 'wire' | 'note'
  // Режим добавления стикеров: следующий клик по холсту ставит заметку.
  let notePlacing = false;
  // Выделенная заметка (не входит в общую склейку модулей).
  let selectedNoteId = null;
  let activePort = null;       // { moduleId, side, index } — первый выбранный порт
  let pendingWire = null;      // { moduleId, side, index } — второй порт, ждём тип L1…PE
  // Множество портов под напряжением, посчитанное calculatePowerFlow().
  // Используется рендером для подсветки клемм шин.
  let livePorts = new Set();
  let selectedConnectionId = null;
  // Контекстное меню ПКМ: { kind: 'module' | 'wire' | 'canvas', id, svgPoint }.
  let contextMenuState = null;
  // Последний модуль под ПКМ — запасной источник для Ctrl+C без выделения.
  let lastContextModuleId = null;
  // Буфер обмена модулями: { items: [{ data, groupId }] }. Провода не копируются.
  let moduleClipboard = null;
  // Последняя точка курсора над холстом в координатах схемы (площадка для Ctrl+V).
  let lastPointerSvgPoint = null;
  // Идентификаторы модулей, выделенных рамкой / Shift+кликом.
  const selectedModuleIds = new Set();
  // Активный жест рамки: { startX, startY, clientX, clientY, moved, shiftKey }.
  let selectionBoxState = null;
  let gesture = null;
  let dragState = null;
  // Состояние viewBox: x/y — левый верхний угол в координатах схемы,
  // zoom — коэффициент масштаба (1 = 100%).
  const viewState = { x: 0, y: 0, zoom: 1 };
  let panState = null;
  let spaceHeld = false;
  let renderScheduled = false;
  let suppressCanvasClickUntil = 0;
  // Одиночный клик по провору отложен: пока не истечёт это время, кнопка ×
  // (появляется при выделении) не успеет перехватить второй клик двойного
  // щелчка. Таймер сбрасывается в onWireDblClick / onCanvasDblClick.
  let wireSelectTimer = null;
  // Та же задержка для рычажка: два одиночных клика по нему не должны
  // дважды переключать автомат, пока пользователь пытается задать подпись.
  let moduleToggleTimer = null;
  let storageErrorAnnounced = false;
  let isLibraryFiltering = false;
  let showMigrationBanner = false;
  let migrationNotice = MIGRATION_NOTICE;
  // Снимки только реек и связей: название проекта и прочие метаданные
  // не должны «откатываться» вместе со структурой щита.
  let history = [];
  let historyIndex = -1;
  const libraryOpenState = new Set(LIBRARY_CATEGORIES.length ? [LIBRARY_CATEGORIES[0].id] : []);
  const bootNotices = [];

  /* ----------------------------- Utilities ---------------------------- */

  function makeId(prefix) {
    const randomPart = (() => {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      }
      return Math.random().toString(36).slice(2, 10);
    })();
    return `${prefix}_${Date.now().toString(36)}_${randomPart}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // Мощность нагрузки хранится в ваттах и всегда приводится к безопасному
  // целому числу в допустимом диапазоне (и для библиотеки, и для проекта).
  function normalizeLoadPower(value, fallback = DEFAULT_LOAD_POWER) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(Math.round(parsed), MIN_LOAD_POWER, MAX_LOAD_POWER);
  }

  function isLoadModule(module) {
    return Boolean(module) && (
      module.type === 'load' || LIBRARY_BY_ID.get(module.libraryId)?.type === 'load'
    );
  }

  // Номинал защитного аппарата (C16 -> 16, "25A" -> 25). Используется
  // для проверки перегрузки: ток нагрузки больше номинала -> красный автомат.
  function protectiveRating(module) {
    if (!module) return null;
    const explicit = Number(module.ratedCurrent);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    const fromName = (name) => {
      const text = String(name || '');
      const match = text.match(/\bC\s?(\d{1,3})\b/i) || text.match(/\b(\d{1,3})\s*A\b/i);
      if (!match) return null;
      const value = Number(match[1]);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    return fromName(module.name) || fromName(LIBRARY_BY_ID.get(module.libraryId)?.name);
  }

  // Короткие подписи для плашек на проводах и корпусе нагрузки.
  function formatCurrent(value) {
    const amps = Number(value) || 0;
    const text = Math.abs(amps) < 1000
      ? amps.toFixed(1).replace(/\.0$/, '')
      : Math.round(amps).toString();
    return `${text}A`;
  }

  function formatPower(value) {
    return `${Math.round(Number(value) || 0)}W`;
  }

  function sumWidths(modules) {
    return modules.reduce((total, module) => total + module.width, 0);
  }

  function allModules() {
    return project.rails.reduce((modules, rail) => modules.concat(rail.modules), []);
  }

  /* --------------------------- Стикеры (заметки) -----------------------
     Заметки не живут на рейке: это свободно лежащие на холсте прямоугольники
     с текстом. Позиция хранится в координатах viewBox, поэтому не зависит от
     зума и панорамирования. */
  function notes() {
    return Array.isArray(project?.notes) ? project.notes : [];
  }

  function noteById(noteId) {
    return notes().find((note) => note.id === noteId) || null;
  }

  function noteLimits() {
    return {
      maxX: Math.max(0, canvasWidth() - NOTE_WIDTH),
      maxY: Math.max(0, canvasHeight() - NOTE_HEIGHT)
    };
  }

  function clampNotePosition(x, y) {
    const limits = noteLimits();
    return {
      x: clamp(x, 0, limits.maxX),
      y: clamp(y, 0, limits.maxY)
    };
  }

  /* ------------------ Склейка модулей (группы) ------------------------
     groupId хранится прямо в объекте модуля, поэтому попадает и в JSON
     экспорта, и в localStorage вместе со всем проектом. Формат жёстко
     ограничен: только строки вида grp_… из makeId('grp'). */
  function safeGroupId(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return /^grp_[A-Za-z0-9_-]{1,80}$/.test(text) ? text : null;
  }

  function selectedModules() {
    return allModules().filter((module) => selectedModuleIds.has(module.id));
  }

  function modulesOfGroup(groupId) {
    if (!groupId) return [];
    return allModules().filter((module) => module.groupId === groupId);
  }

  // Удаление модуля из склейки разрывает группу: остатки просто перестают
  // быть склеенными (как принято в большинстве редакторов).
  function dissolveGroupsOf(modules) {
    const groupIds = new Set();
    modules.forEach((module) => {
      if (module?.groupId) groupIds.add(module.groupId);
    });
    if (groupIds.size === 0) return;
    allModules().forEach((module) => {
      if (module.groupId && groupIds.has(module.groupId)) delete module.groupId;
    });
  }

  function usedWidth(rail = null) {
    return rail ? sumWidths(rail.modules) : sumWidths(allModules());
  }

  function railById(railId) {
    return project.rails.find((rail) => rail.id === railId) || null;
  }

  function railIndexOf(railId) {
    return project.rails.findIndex((rail) => rail.id === railId);
  }

  function railOffsetY(railIndex) {
    return railIndex * RAIL_PITCH;
  }

  function railPlateY(railIndex) {
    return RAIL.y + railOffsetY(railIndex);
  }

  function railModuleY(railIndex) {
    return RAIL.moduleY + railOffsetY(railIndex);
  }

  // Ширина пластины рейки зависит от вместимости: capacity * 48px + поля.
  function railWidth(capacity) {
    return capacity * MODULE_UNIT + RAIL_PAD_LEFT + RAIL_PAD_RIGHT;
  }

  // Правая кромка пластины и конец шкалы делений (последний слот).
  function railRightEdge(capacity) {
    return RAIL.x + railWidth(capacity);
  }

  function railModuleRight(capacity) {
    return RAIL.moduleX + capacity * MODULE_UNIT;
  }

  // Центр зоны модулей конкретной рейки — нужен для выбора коридора провода.
  function railModuleCenter(railIndex) {
    const rail = project.rails[railIndex];
    return (RAIL.moduleX + railModuleRight(rail ? rail.capacity : RAIL.capacity)) / 2;
  }

  /* ------------------------- Slot geometry (слоты) ---------------------
     Модуль хранит не порядковый номер, а начальный слот slot.
     Занимаемые слоты: slot .. slot + width - 1.
     Пустые слоты между модулями допустимы и сохраняются при переносе.
     X модуля = RAIL.startX + slot * MODULE_UNIT.
  --------------------------------------------------------------------- */

  function moduleSlotX(slot) {
    return RAIL.startX + slot * MODULE_UNIT;
  }

  // Слот, на который «прилипает» модуль при перетаскивании.
  function slotFromX(svgX, width, capacity, grabOffsetPx = 0) {
    const localX = svgX - grabOffsetPx - RAIL.startX;
    const raw = Math.round(localX / MODULE_UNIT);
    return clamp(raw, 0, Math.max(0, capacity - width));
  }

  function clampSlot(rail, slot, width) {
    const parsed = Number(slot);
    const value = Number.isFinite(parsed) ? Math.round(parsed) : 0;
    return clamp(value, 0, Math.max(0, rail.capacity - width));
  }

  // Множество всех занятых слотов рейки (кроме исключаемого модуля).
  function occupiedSlots(rail, excludeModuleId = null) {
    const used = new Set();
    for (const module of rail.modules) {
      if (module.id === excludeModuleId) continue;
      for (let offset = 0; offset < module.width; offset += 1) {
        used.add(module.slot + offset);
      }
    }
    return used;
  }

  function rangeIsFree(used, slot, width) {
    for (let offset = 0; offset < width; offset += 1) {
      if (used.has(slot + offset)) return false;
    }
    return true;
  }

  function firstFreeSlot(used, width, capacity) {
    for (let slot = 0; slot + width <= capacity; slot += 1) {
      if (rangeIsFree(used, slot, width)) return slot;
    }
    return null;
  }

  // Главная проверка: модуль помещается, если все его слоты свободны
  // и он не выходит за правый край рейки.
  function canPlaceModule(rail, slot, width, excludeModuleId = null) {
    if (!Number.isInteger(slot) || slot < 0 || slot + width > rail.capacity) return false;
    return rangeIsFree(occupiedSlots(rail, excludeModuleId), slot, width);
  }

  // Поиск свободного места для добавления «в конец» (сохранение зазоров).
  function findFreeSlot(rail, width, excludeModuleId = null) {
    return firstFreeSlot(occupiedSlots(rail, excludeModuleId), width, rail.capacity);
  }

  function findFreeSlotAtEnd(rail, width, excludeModuleId = null) {
    let lastEnd = 0;
    for (const module of rail.modules) {
      if (module.id === excludeModuleId) continue;
      lastEnd = Math.max(lastEnd, module.slot + module.width);
    }
    if (canPlaceModule(rail, lastEnd, width, excludeModuleId)) return lastEnd;
    return findFreeSlot(rail, width, excludeModuleId);
  }

  // Холст расширяется вместе с самой длинной рейкой, чтобы длинная рейка
  // никогда не вылезала за viewBox (и не обрезалась при экспорте PNG).
  function canvasWidth() {
    const widest = project.rails.reduce((max, rail) =>
      Math.max(max, railRightEdge(rail.capacity)), 0);
    return Math.max(SVG_WIDTH, widest + 24);
  }

  function canvasHeight() {
    return SVG_BASE_HEIGHT + railOffsetY(project.rails.length - 1);
  }

  function railWithRoom(width) {
    return project.rails.find((rail) => findFreeSlot(rail, width) !== null) || project.rails[0];
  }

  function railOfModule(moduleId) {
    for (const rail of project.rails) {
      const module = rail.modules.find((item) => item.id === moduleId);
      if (module) return { rail, module, index: railIndexOf(rail.id) };
    }
    return null;
  }

  // Локальная точка порта источника — внутри его группы с transform="translate".
  // Один и тот же helper используется и для отрисовки кружка, и для расчёта
  // абсолютной точки провода, поэтому порт физически не может «отпорваться».
  function localSourcePortPoint(index) {
    const count = POWER_SOURCE.ports.length;
    return {
      x: ((index + 1) * POWER_SOURCE.width) / (count + 1),
      y: POWER_SOURCE.height
    };
  }

  function sourcePortPoint(index) {
    const point = localSourcePortPoint(index);
    return {
      x: POWER_SOURCE.x + point.x,
      y: POWER_SOURCE.y + point.y
    };
  }

  function isPowerSourcePort(ref) {
    return Boolean(ref) && ref.moduleId === POWER_SOURCE.id;
  }

  /* --------------------------- Busbars (шины) -------------------------- */

  // Тип шины (N / PE) хранится в самом модуле; для старых сохранений он
  // восстанавливается по записи библиотеки.
  function busbarTypeOf(module) {
    // busType — каноничное свойство новых боковых шин; busbarType остаётся
    // для обратной совместимости со старыми сохранениями и широкими шинами.
    if (module?.busType === 'N' || module?.busType === 'PE') return module.busType;
    if (module?.busbarType === 'N' || module?.busbarType === 'PE') return module.busbarType;
    const libraryItem = LIBRARY_BY_ID.get(module?.libraryId);
    const libraryType = libraryItem?.busType || libraryItem?.busbarType;
    return libraryType === 'N' || libraryType === 'PE' ? libraryType : null;
  }

  function isBusbarModule(module) {
    return Boolean(module?.isBusbar) || busbarTypeOf(module) !== null;
  }

  function busbarTypeForRef(ref) {
    if (!ref || isPowerSourcePort(ref)) return null;
    const module = moduleById(ref.moduleId);
    return isBusbarModule(module) ? busbarTypeOf(module) : null;
  }

  function moduleHasLivePort(module, liveSet) {
    if (!module) return false;
    const counts = portsForModule(module);
    for (const side of PORT_SIDES) {
      for (let index = 0; index < counts[side]; index += 1) {
        if (liveSet?.has(makePortId(module.id, side, index))) return true;
      }
    }
    return false;
  }

  // Если фаза провода уже определена клеммой/модулем, в поповере активна
  // только она: остальные кнопки блокируются и помечаются замочком.
  function updateWireTypeOptions() {
    if (!dom.wireTypePopover) return;
    const forced = draftWireType();
    const buttons = dom.wireTypePopover.querySelectorAll('[data-wire-type-option]');

    buttons.forEach((button) => {
      const type = button.dataset.wireTypeOption;
      if (forced) {
        const isForced = type === forced;
        button.disabled = !isForced;
        button.classList.toggle('is-locked', !isForced);
        button.classList.toggle('is-required', isForced);
        if (isForced) {
          button.title = `Фаза задана портом: ${forced}`;
          button.setAttribute('aria-label', `Тип провода ${type} — обязателен по фазировке`);
        } else {
          button.title = `Заблокировано: фаза порта — ${forced}`;
          button.removeAttribute('aria-label');
        }
      } else {
        button.disabled = false;
        button.classList.remove('is-locked', 'is-required');
        button.removeAttribute('title');
        button.removeAttribute('aria-label');
      }
    });

    const desc = document.getElementById('wire-type-desc');
    if (desc) {
      desc.textContent = forced
        ? `Фаза ${forced} задана портом · остальные типы заблокированы`
        : 'Выберите назначение';
    }
  }

  function isPortRefValid(ref) {
    if (!ref || !isPortSide(ref.side) || !Number.isInteger(ref.index)) return false;
    if (isPowerSourcePort(ref)) {
      return ref.side === 'bottom' &&
        ref.index >= 0 &&
        ref.index < POWER_SOURCE.ports.length;
    }
    const module = moduleById(ref.moduleId);
    if (!module) return false;
    const counts = portsForModule(module);
    return ref.index >= 0 && ref.index < (counts[ref.side] || 0);
  }

  function portRefLabel(ref) {
    if (!ref) return '?';
    if (isPowerSourcePort(ref)) {
      const label = POWER_SOURCE.ports[ref.index];
      return label ? `Источник · ${label}` : 'Источник';
    }
    const module = moduleById(ref.moduleId);
    return module ? formatPortLabel(module, ref.side, ref.index) : '?';
  }

  function plural(number, forms) {
    const abs = Math.abs(number) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return forms[2];
    if (last === 1) return forms[0];
    if (last >= 2 && last <= 4) return forms[1];
    return forms[2];
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return entities[character];
    });
  }

  function safeText(value, fallback, maxLength) {
    if (typeof value !== 'string') return fallback;
    const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
    return cleaned || fallback;
  }

  function safeId(value) {
    return typeof value === 'string' && ID_RE.test(value) ? value : '';
  }

  function safeColor(value) {
    return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value.toLowerCase() : '';
  }

  function safeTag(value) {
    if (typeof value !== 'string') return '';
    const cleaned = value.trim();
    return /^[A-Za-zА-Яа-я0-9_-]{1,10}$/u.test(cleaned) ? cleaned : '';
  }

  function generateTag(prefix, modules, reservedTags = null) {
    const normalizedPrefix = /^[A-Za-zА-Яа-я]{1,4}$/u.test(prefix) ? prefix.toUpperCase() : 'M';
    const used = new Set();

    for (const module of modules) {
      const tag = String(module.tag || '').trim().toUpperCase();
      if (tag) used.add(tag);
    }
    if (reservedTags instanceof Set) {
      reservedTags.forEach((tag) => used.add(String(tag).trim().toUpperCase()));
    }

    // Не max+1, а первый свободный номер: QF1 + QF3 -> новый QF2.
    for (let number = 1; number <= 9999; number += 1) {
      const candidate = `${normalizedPrefix}${number}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${normalizedPrefix}${Math.floor(1000 + Math.random() * 9000)}`;
  }

  function typeLabelFor(module) {
    return LIBRARY_BY_ID.get(module.libraryId)?.typeLabel ||
      LEGACY_TYPE_LABELS[module.type] ||
      'Модуль';
  }

  function relativeLuminance(color) {
    const hex = safeColor(color) || '#000000';
    const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
    const linear = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  function contrastRatio(first, second) {
    const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
    const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  }

  function tagTextClass(color) {
    const onDark = contrastRatio(color, '#ffffff');
    const onLight = contrastRatio(color, '#0b1220');
    return onLight >= onDark ? 'is-dark-text' : 'is-light-text';
  }

  /* Только для подписи на лицевой панели: номинал берём из названия модуля. */
  function moduleRating(module) {
    const name = String(module?.name || '');
    const match = name.match(/(C\d{1,2}|\d+(?:[.,]\d+)?\s*(?:A|V|В|мм²))/i);
    if (match) return match[0].replace(/\s+/g, '');
    const defaults = {
      breaker: 'C16', rcbo: 'C16', rcd: '30mA', contactor: 'AC-3',
      relay: '230V', 'impulse-relay': '230V', timer: '24V',
      'power-supply': '24V', voltmeter: '~230V', meter: '~230V',
      terminal: '4mm²', busbar: '4mm²'
    };
    return defaults[module?.type] || module?.tag || 'C16';
  }

  function moduleBrand(module) {
    // Бренд задаётся в library.js; старые/неизвестные модули получают
    // резервное значение по типу, чтобы лицевая панель не пустовала.
    const libraryBrand = LIBRARY_BY_ID.get(module?.libraryId)?.brand;
    return safeText(libraryBrand, '', 60) || MODULE_BRANDS[module?.type] || 'DINPRO';
  }

  // Артикул тоже хранится в базе элементов, а не в сохранённом проекте:
  // редактирование library.js сразу отражается в спецификации и CSV.
  function moduleSku(module) {
    const librarySku = LIBRARY_BY_ID.get(module?.libraryId)?.sku;
    return safeText(librarySku, '', 60) || '';
  }

  // Ключ кастомной цены — id элемента библиотеки (libraryId), по которому
  // buildSpecification() группирует одинаковые модули в одну строку сметы.
  // Для унаследованных модулей без libraryId ключом остаётся их название.
  function priceKeyFor(module) {
    return module?.libraryId || `name:${module?.name || ''}`;
  }

  // Цена берётся из library.js (поле price). Для устаревших позиций без цены
  // используется резервное значение по типу, чтобы смета всегда была заполнена.
  // Введённая пользователем цена (project.customPrices) имеет приоритет над
  // базовой: она редактируется прямо в таблице сметы и сохраняется в проекте.
  function modulePrice(module) {
    const customPrices = project?.customPrices;
    if (customPrices && typeof customPrices === 'object' && !Array.isArray(customPrices)) {
      const key = priceKeyFor(module);
      if (Object.prototype.hasOwnProperty.call(customPrices, key)) {
        const custom = Number(customPrices[key]);
        if (Number.isFinite(custom) && custom >= 0) return roundMoney(custom);
      }
    }

    const libraryPrice = LIBRARY_BY_ID.get(module?.libraryId)?.price;
    if (typeof libraryPrice === 'number' && Number.isFinite(libraryPrice) && libraryPrice >= 0) {
      return libraryPrice;
    }
    const fallback = DEFAULT_PRICE_BY_TYPE[module?.type];
    return Number.isFinite(fallback) ? fallback : 0;
  }

  // Цена за метр провода: кастомная из project.customCablePrices имеет
  // приоритет над базовой WIRE_PRICE_PER_METER. Ключ — тип проводника
  // (L1, L2, L3, N, PE), поэтому коллизий с ценами модулей нет: те лежат
  // в отдельном объекте project.customPrices.
  function wirePrice(type) {
    const customPrices = project?.customCablePrices;
    if (customPrices && typeof customPrices === 'object' && !Array.isArray(customPrices) &&
        Object.prototype.hasOwnProperty.call(customPrices, type)) {
      const custom = Number(customPrices[type]);
      if (Number.isFinite(custom) && custom >= 0) return roundMoney(custom);
    }
    return WIRE_PRICE_PER_METER;
  }

  function moduleHasSwitch(module) {
    return SWITCHABLE_MODULE_TYPES.has(module?.type);
  }

  function truncateLabel(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }

  // Разбивает подпись на до двух строк по словам; всё, что не поместилось,
  // заменяется многоточием. Ширина считается в символах — для мелкого шрифта
  // этого достаточно, чтобы текст гарантированно не вылезал за модуль.
  function fitTextLines(value, maxChars, maxLines = 2) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const lines = [''];
    let truncated = false;

    for (const word of words) {
      const last = lines.length - 1;
      const candidate = lines[last] ? `${lines[last]} ${word}` : word;
      if (candidate.length <= maxChars) {
        lines[last] = candidate;
        continue;
      }
      if (lines.length < maxLines) {
        if (word.length <= maxChars) {
          lines.push(word);
          continue;
        }
        let rest = word;
        while (rest.length > maxChars && lines.length < maxLines) {
          lines.push(rest.slice(0, maxChars));
          rest = rest.slice(maxChars);
        }
        if (rest && lines.length < maxLines) lines.push(rest);
        else if (rest) truncated = true;
        continue;
      }
      truncated = true;
      break;
    }

    if (truncated) {
      const last = lines.length - 1;
      lines[last] = `${lines[last].slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
    }
    return lines.filter(Boolean);
  }

  // Базовая линия пользовательского описания зависит от типа корпуса:
  // у шин и нагрузки заводской текст занимает другие места.
  function moduleDescriptionBaseline(module) {
    if (!module || isLoadModule(module)) return null;
    if (isBusbarModule(module)) {
      const counts = portsForModule(module);
      return counts.left > 0 || counts.right > 0
        ? MODULE_HEIGHT - 48
        : MODULE_HEIGHT - 34;
    }
    return MODULE_HEIGHT - 28;
  }

  // Цвет описания раньше наследовался от класса корпуса. Теперь текст живёт
  // в слое подписей, поэтому нужный вариант цвета задаётся явно.
  function moduleDescriptionColorClass(module) {
    const counts = portsForModule(module);
    const isSideBusbar = isBusbarModule(module) && (counts.left > 0 || counts.right > 0);
    if (isBusbarModule(module) && !isSideBusbar) return ' module-description--busbar';
    if (isSideBusbar || MODULE_BODY_VARIANTS[module.type] === 'dark') {
      return ' module-description--dark';
    }
    return '';
  }

  // Подпись модуля: одна строка, крупный жирный шрифт (12px в CSS), жёстко
  // центрированная в корпусе. Длинный текст обрезается многоточием — так он
  // никогда не вылезает за границы модуля, даже у 1P корпуса.
  // Координаты АБСОЛЮТНЫЕ (viewBox), потому что элемент уходит в #layer-labels,
  // а не в сдвинутую группу модуля.
  function moduleDescriptionMarkup(module, position, baselineY) {
    const text = typeof module?.description === 'string' ? module.description.trim() : '';
    if (!text || module.__ghost) return '';
    const width = position.width;
    const available = Math.max(18, width - 10);
    // ~7.2 px на символ при 12px bold — консервативная оценка для кириллицы.
    const maxChars = Math.max(4, Math.floor(available / 7.2));
    const label = truncateLabel(text, maxChars);
    const x = position.x + width / 2;
    const y = position.y + baselineY;
    return `<text class="module-description${moduleDescriptionColorClass(module)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>`;
  }

  // Подложка ограничена 280 px, поэтому видимая подпись не может быть длиннее
  // ~34 символов при 12px — иначе текст вылезет за её границы.
  const WIRE_LABEL_MAX_CHARS = Math.min(
    MAX_WIRE_LABEL_LENGTH,
    Math.floor((280 - 22) / 7.4)
  );

  function wireLabelText(value) {
    return truncateLabel(String(value || '').trim(), WIRE_LABEL_MAX_CHARS);
  }

  function wireLabelWidth(text) {
    // Шрифт 12px: запас на буквы и внутренние отступы подложки.
    return clamp(wireLabelText(text).length * 7.4 + 22, 34, 280);
  }

  // Маркировка провода: горизонтальная подпись ровно по центру провода.
  // <rect> — подложка цвета холста, чтобы линия не перечёркивала буквы;
  // <text> — сам текст. Никакого вращения вместе с полилинией нет.
  function wireLabelMarkup(connection, badgeX, badgeY) {
    const text = typeof connection?.label === 'string' ? connection.label.trim() : '';
    if (!text) return '';
    const label = wireLabelText(text);
    const width = wireLabelWidth(text);
    return `
      <g class="wire-label" data-connection-id="${escapeHtml(connection.id)}"
         transform="translate(${badgeX.toFixed(1)} ${badgeY.toFixed(1)})">
        <rect class="wire-label-bg" x="${(-width / 2).toFixed(1)}" y="-10"
              width="${width.toFixed(1)}" height="20" rx="6"/>
        <text class="wire-label-text" x="0" y="4">${escapeHtml(label)}</text>
      </g>`;
  }

  function wireDisplayColor(type) {
    return WIRE_DISPLAY_COLORS[type] || WIRE_DISPLAY_COLORS[DEFAULT_WIRE_TYPE];
  }

  /* Нативные SVG-градиенты и штрихи Pattern добавляются один раз при старте.
     Ни логика, ни схема данных, ни координаты элементов этим не меняются. */
  const VISUAL_DEFS_MARKUP = `
    <radialGradient id="rail-screw-radial" cx="0.36" cy="0.3" r="0.86">
      <stop class="screw-stop-top" offset="0"/>
      <stop class="screw-stop-mid" offset="0.58"/>
      <stop class="screw-stop-bottom" offset="1"/>
    </radialGradient>
    <radialGradient id="module-screw-gradient" cx="0.36" cy="0.3" r="0.9">
      <stop class="module-screw-top" offset="0"/>
      <stop class="module-screw-mid" offset="0.56"/>
      <stop class="module-screw-bottom" offset="1"/>
    </radialGradient>
    <linearGradient id="module-shadow-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop class="module-shadow-start" offset="0"/>
      <stop class="module-shadow-mid" offset="0.52"/>
      <stop class="module-shadow-end" offset="1"/>
    </linearGradient>
    <linearGradient id="rail-hole-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop class="hole-stop-top" offset="0"/>
      <stop class="hole-stop-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="screw-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop class="screw-stop-top" offset="0"/>
      <stop class="screw-stop-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="module-body-standard" x1="0" y1="0" x2="0" y2="1">
      <stop class="body-standard-top" offset="0"/>
      <stop class="body-standard-mid" offset="0.5"/>
      <stop class="body-standard-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="module-body-light" x1="0" y1="0" x2="0" y2="1">
      <stop class="body-light-top" offset="0"/>
      <stop class="body-light-mid" offset="0.5"/>
      <stop class="body-light-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="module-body-dark" x1="0" y1="0" x2="0" y2="1">
      <stop class="body-dark-top" offset="0"/>
      <stop class="body-dark-mid" offset="0.5"/>
      <stop class="body-dark-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="module-body-terminal" x1="0" y1="0" x2="0" y2="1">
      <stop class="body-terminal-top" offset="0"/>
      <stop class="body-terminal-mid" offset="0.5"/>
      <stop class="body-terminal-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="busbar-copper-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop class="busbar-copper-top" offset="0"/>
      <stop class="busbar-copper-mid" offset="0.48"/>
      <stop class="busbar-copper-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="busbar-silver-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop class="busbar-silver-top" offset="0"/>
      <stop class="busbar-silver-mid" offset="0.48"/>
      <stop class="busbar-silver-bottom" offset="1"/>
    </linearGradient>
    <linearGradient id="module-gloss-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop class="gloss-stop-top" offset="0"/>
      <stop class="gloss-stop-bottom" offset="1"/>
    </linearGradient>`;

  function appendSvgMarkup(parent, markup) {
    const holder = document.createElement('div');
    holder.innerHTML = `<svg xmlns="${SVG_NS}">${markup}</svg>`;
    const wrapper = holder.firstElementChild;
    while (wrapper.firstChild) parent.appendChild(wrapper.firstChild);
  }

  function installVisualDefs() {
    const defs = dom.canvas?.querySelector('defs');
    if (!defs || defs.dataset.visualDefs === 'true') return;
    defs.dataset.visualDefs = 'true';

    appendSvgMarkup(defs, VISUAL_DEFS_MARKUP);

    const railGradient = defs.querySelector('#rail-metal-gradient');
    if (railGradient) {
      // Профиль металла: светлая верхняя кромка, тёмная середина и блик
      // на нижней полке. Центральная часть скрыта каналом рейки.
      const stops = [
        ['rail-metal-highlight', '0'],
        ['rail-metal-start', '0.07'],
        ['rail-metal-mid', '0.17'],
        ['rail-metal-deep', '0.31'],
        ['rail-metal-deep', '0.69'],
        ['rail-metal-mid', '0.83'],
        ['rail-metal-highlight', '0.92'],
        ['rail-metal-end', '1']
      ];
      railGradient.replaceChildren(...stops.map(([className, offset]) => {
        const stop = document.createElementNS(SVG_NS, 'stop');
        stop.setAttribute('class', className);
        stop.setAttribute('offset', offset);
        return stop;
      }));
    }

    const holePattern = defs.querySelector('#rail-holes');
    if (holePattern) {
      const hole = holePattern.querySelector('.rail-hole');
      if (hole) {
        hole.setAttribute('x', '8.5');
        hole.setAttribute('y', '6');
        hole.setAttribute('width', '9');
        hole.setAttribute('height', '5');
        hole.setAttribute('rx', '2.5');
      }
      if (!holePattern.querySelector('.rail-hole-shine')) {
        appendSvgMarkup(
          holePattern,
          '<rect class="rail-hole-shine" x="8.5" y="6" width="9" height="1.5" rx="0.75"/>'
        );
      }
    }

    // Мягкая, но не «тяжёлая» тень самой рейки.
    const railShadow = defs.querySelector('#rail-shadow feDropShadow');
    if (railShadow) {
      railShadow.setAttribute('dy', '7');
      railShadow.setAttribute('stdDeviation', '8');
      railShadow.setAttribute('flood-opacity', '0.5');
    }
  }

  // Создаёт (или заново очищает) структуру холста: три переключаемых
  // слоя + две всегда видимые группы. Вызывается один раз при старте:
  // устаревшие группы (бывший #layer-rails, старый #layer-ports) удаляются,
  // недостающие создаются, все пять выстраиваются в нужном порядке перед
  // рамкой выделения. Порядок задаёт z-index: рейки → провода → модули →
  // источник → подписи.
  // Сами теги <g> при последующих перерисовках НЕ удаляются — очищается
  // только их внутреннее содержимое. Статичные группы никогда не получают
  // классы .hidden/.locked: их нельзя скрыть или заблокировать из панели.
  function setupSvgLayerStructure() {
    const { canvas, selectionBox } = dom;
    if (!canvas) return;

    const switchableIds = LAYER_KEYS.map((key) => LAYER_ELEMENT_IDS[key]);
    canvas.querySelectorAll('g[id^="layer-"]').forEach((group) => {
      const keep = switchableIds.includes(group.id) ||
        STATIC_GROUP_IDS.includes(group.id) || group.id === NOTES_GROUP_ID;
      if (!keep) group.remove();
    });

    const orderedIds = [
      STATIC_GROUP_RAIL_ID,
      LAYER_ELEMENT_IDS.wires,
      LAYER_ELEMENT_IDS.modules,
      STATIC_GROUP_LAYER_ID,
      LAYER_ELEMENT_IDS.labels,
      NOTES_GROUP_ID
    ];

    orderedIds.forEach((id) => {
      let group = canvas.querySelector(`#${id}`);
      if (!group) {
        group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('id', id);
      }
      const isSwitchable = switchableIds.includes(id);
      group.classList.toggle('layer', isSwitchable);
      // Состояния задаются только классами .hidden / .locked.
      group.classList.remove('hidden', 'locked');
      group.innerHTML = '';
      if (selectionBox && selectionBox.parentNode === canvas) {
        canvas.insertBefore(group, selectionBox);
      } else {
        canvas.appendChild(group);
      }
    });

    dom.railTrack = canvas.querySelector(`#${STATIC_GROUP_RAIL_ID}`);
    dom.powerSourceLayer = canvas.querySelector(`#${STATIC_GROUP_LAYER_ID}`);
    dom.notesLayer = canvas.querySelector(`#${NOTES_GROUP_ID}`);
    for (const key of LAYER_KEYS) {
      dom[LAYER_DOM_FIELDS[key]] = canvas.querySelector(`#${LAYER_ELEMENT_IDS[key]}`);
    }
  }

  // Применяет сохранённые состояния слоёв к DOM и к кнопкам панели.
  function applyLayerSettings() {
    const settings = (project && project.layerSettings) || createLayerSettings();
    for (const key of LAYER_KEYS) {
      const state = settings[key] || { visible: true, locked: false };
      const element = document.getElementById(LAYER_ELEMENT_IDS[key]);
      if (element) {
        element.classList.toggle('hidden', !state.visible);
        element.classList.toggle('locked', state.locked);
      }
      if (!dom.layersList) continue;
      dom.layersList.querySelectorAll(`.layer-toggle[data-layer="${key}"]`).forEach((button) => {
        const isVisibility = button.dataset.layerAction === 'visible';
        const pressed = isVisibility ? state.visible : state.locked;
        button.setAttribute('aria-pressed', String(pressed));
        const verb = isVisibility
          ? (state.visible ? 'Скрыть' : 'Показать')
          : (state.locked ? 'Разблокировать' : 'Заблокировать');
        const label = `${verb} слой ${LAYER_NAMES[key]}`;
        button.setAttribute('aria-label', label);
        button.title = label;
      });
    }
  }

  // Переключает видимость или блокировку слоя и сразу сохраняет проект.
  function setLayerSetting(key, action) {
    if (!project || !LAYER_KEYS.includes(key)) return;
    if (!project.layerSettings) project.layerSettings = createLayerSettings();
    const state = project.layerSettings[key] ||
      (project.layerSettings[key] = { visible: true, locked: false });
    if (action === 'visible') state.visible = !state.visible;
    else if (action === 'lock') state.locked = !state.locked;
    else return;
    applyLayerSettings();
    commitHistory();
    persistProject();
  }

  function toggleLayersPanel(force) {
    if (!dom.layersToggle || !dom.layersList) return;
    const expanded = force === undefined
      ? dom.layersToggle.getAttribute('aria-expanded') !== 'true'
      : Boolean(force);
    dom.layersToggle.setAttribute('aria-expanded', String(expanded));
    dom.layersList.hidden = !expanded;
  }

  function portsForModule(module) {
    if (module?.isPowerSource || module?.id === POWER_SOURCE.id) {
      return { top: 0, right: 0, bottom: POWER_SOURCE.ports.length, left: 0 };
    }
    const configured = module?.ports || LIBRARY_BY_ID.get(module?.libraryId)?.ports;
    if (configured) {
      // Грани, которых нет в конфигурации (в том числе все новые боковые
      // грани старых модулей), получают 0 портов. Верхний предел 10 — ровно
      // столько клемм у боковых шин N/PE.
      const count = (side) => {
        const value = configured[side];
        if (value === undefined || value === null || value === '') return 0;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? clamp(Math.round(parsed), 0, 10) : 0;
      };
      return { top: count('top'), right: count('right'), bottom: count('bottom'), left: count('left') };
    }
    // Legacy/unknown modules get at least one port per DIN unit.
    const fallback = clamp(Math.round(Number(module?.width) || 1), 1, 6);
    return { top: fallback, right: 0, bottom: fallback, left: 0 };
  }

  function makePortId(moduleId, side, index) {
    return `${moduleId}:${side}:${index}`;
  }

  function isPortSide(value) {
    return PORT_SIDES.includes(value);
  }

  function isSidePort(side) {
    return SIDE_PORT_SIDES.includes(side);
  }

  // Локальная точка клеммы относительно левого верхнего угла корпуса модуля.
  // Именно эти cx/cy получают кружки портов внутри <g class="module">.
  // Никаких координат нуля холста: x=0 — левая грань корпуса, y=0 — верхняя.
  function localModulePortPoint(width, side, index, counts) {
    if (side === 'top' || side === 'bottom') {
      return {
        x: ((index + 1) * width) / (counts[side] + 1),
        y: side === 'top' ? 0 : MODULE_HEIGHT
      };
    }
    return {
      x: side === 'left' ? 0 : width,
      y: ((index + 1) * MODULE_HEIGHT) / (counts[side] + 1)
    };
  }

  // Абсолютная точка клеммы в координатах viewBox: локальная точка + сдвиг
  // группы модуля. Одна формула для рендера порта и трассировки провода —
  // клик по порту и конец полилинии совпадают при любом зуме и перетаскивании.
  function modulePortPoint(position, side, index, counts = portsForModule(position.module)) {
    const local = localModulePortPoint(position.width, side, index, counts);
    return {
      x: position.x + local.x,
      y: position.y + local.y
    };
  }

  function normalizePortIndex(value, module, side) {
    const count = portsForModule(module)[side] || 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) && count > 0
      ? clamp(Math.round(parsed), 0, count - 1)
      : 0;
  }

  function moduleById(moduleId) {
    return railOfModule(moduleId)?.module || null;
  }

  function getPortPoint(moduleId, side, index, positions) {
    if (moduleId === POWER_SOURCE.id) {
      if (side !== 'bottom' || !Number.isInteger(index) ||
          index < 0 || index >= POWER_SOURCE.ports.length) {
        return null;
      }
      const point = sourcePortPoint(index);
      return {
        moduleId,
        side,
        index,
        railId: null,
        railIndex: -1,
        x: point.x,
        y: point.y
      };
    }

    const position = positions?.get(moduleId);
    const location = railOfModule(moduleId);
    const module = location?.module || position?.module;
    if (!module || !position || !isPortSide(side) || !Number.isInteger(index)) return null;
    const counts = portsForModule(module);
    if (index < 0 || index >= counts[side]) return null;
    const point = modulePortPoint(position, side, index, counts);
    return {
      moduleId,
      side,
      index,
      railId: position.railId || location?.rail.id || null,
      railIndex: Number.isInteger(position.railIndex) ? position.railIndex : (location?.index ?? 0),
      // Порты равномерно распределены по грани модуля (без углов).
      x: point.x,
      y: point.y
    };
  }

  function formatPortLabel(module, side, index) {
    return `${module.tag} · ${PORT_LABELS[side] || side} ${index + 1}`;
  }

  function connectionPortLabel(connection, endpoint) {
    const isFrom = endpoint === 'from';
    const ref = {
      moduleId: isFrom ? connection.fromModuleId : connection.toModuleId,
      side: isFrom ? connection.fromPortSide : connection.toPortSide,
      index: isFrom ? connection.fromPortIndex : connection.toPortIndex
    };
    return portRefLabel(ref);
  }

  function connectionLabel(connection) {
    return `${connectionPortLabel(connection, 'from')} → ${connectionPortLabel(connection, 'to')}`;
  }

  // Рейка вычисляется по moduleId: при перетаскивании привязка обновляется сама.
  function connectionRailIds(connection) {
    return {
      fromRailId: railOfModule(connection.fromModuleId)?.rail.id || connection.fromRailId || null,
      toRailId: railOfModule(connection.toModuleId)?.rail.id || connection.toRailId || null
    };
  }

  function samePort(first, second) {
    return Boolean(first && second) &&
      first.moduleId === second.moduleId &&
      first.side === second.side &&
      first.index === second.index;
  }

  function connectionExists(first, second) {
    return project.connections.some((connection) => {
      const from = { moduleId: connection.fromModuleId, side: connection.fromPortSide, index: connection.fromPortIndex };
      const to = { moduleId: connection.toModuleId, side: connection.toPortSide, index: connection.toPortIndex };
      return (samePort(from, first) && samePort(to, second)) ||
        (samePort(from, second) && samePort(to, first));
    });
  }

  function getPortOccupancy() {
    const occupancy = new Map();
    for (const connection of project.connections) {
      const endpoints = [
        [connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex],
        [connection.toModuleId, connection.toPortSide, connection.toPortIndex]
      ];
      for (const [moduleId, side, index] of endpoints) {
        if (!isPortSide(side) || !Number.isInteger(index)) continue;
        const portId = makePortId(moduleId, side, index);
        occupancy.set(portId, (occupancy.get(portId) || 0) + 1);
      }
    }
    return occupancy;
  }

  /* --------------------------- Phasing (фазировка) ---------------------- */

  // Фаза порта — это тип проводника (L1, L2, L3, N, PE), закреплённый за
  // клеммой. Источник задаёт фазу своей подписью, каждый провод — своим
  // типом, а исправный модуль передаёт фазу с порта одной грани на порт
  // другой грани с тем же индексом (1P: 0→0; 3P: 0→0, 1→1, 2→2).
  //
  // Результат — Map<portId, wireType>. Фаза — это маркировка клеммы, а не
  // «напряжение прямо сейчас», поэтому она не зависит от рычажка модуля:
  // выключенный автомат остаётся «своей» фазой.
  function computePortPhases() {
    const phases = new Map();

    function assign(portId, type) {
      if (!portId || !WIRE_TYPES[type] || phases.has(portId)) return;
      phases.set(portId, type);
    }

    // a) Порты источника питания имеют фазу «от рождения» (по подписи).
    POWER_SOURCE.ports.forEach((label, index) => {
      if (WIRE_TYPES[label]) {
        assign(makePortId(POWER_SOURCE.id, 'bottom', index), label);
      }
    });

    // a2) Шина однородна: ВСЕ её клеммы сразу имеют тип самой шины.
    // Это и есть фазировка шин — к N-шине нельзя подвести L1/L2/L3,
    // а провод, протянутый от шины, заведомо имеет её тип (N или PE).
    for (const module of allModules()) {
      const busType = busbarTypeOf(module);
      if (!busType) continue;
      const counts = portsForModule(module);
      for (const side of PORT_SIDES) {
        for (let index = 0; index < counts[side]; index += 1) {
          phases.set(makePortId(module.id, side, index), busType);
        }
      }
    }

    // b) Каждый конец существующего провода получает его тип.
    for (const connection of project.connections) {
      if (!WIRE_TYPES[connection.type]) continue;
      assign(
        makePortId(connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex),
        connection.type
      );
      assign(
        makePortId(connection.toModuleId, connection.toPortSide, connection.toPortIndex),
        connection.type
      );
    }

    // c) Пропагация через модули до неподвижной точки. Так фаза «проходит»
    //    через всю цепочку автоматов, даже если следующий провод ещё не
    //    подключён: нижняя клемма уже знает, что она L1/N/…
    const modules = allModules();
    let changed = true;
    while (changed) {
      changed = false;
      for (const module of modules) {
        const counts = portsForModule(module);
        const pairs = Math.min(counts.top, counts.bottom);
        for (let index = 0; index < pairs; index += 1) {
          const topId = makePortId(module.id, 'top', index);
          const bottomId = makePortId(module.id, 'bottom', index);
          const topPhase = phases.get(topId);
          const bottomPhase = phases.get(bottomId);
          if (topPhase && !bottomPhase) {
            phases.set(bottomId, topPhase);
            changed = true;
          } else if (bottomPhase && !topPhase) {
            phases.set(topId, bottomPhase);
            changed = true;
          }
        }
      }
    }

    return phases;
  }

  function getPortPhase(ref, phases) {
    if (!ref) return null;
    const portId = makePortId(ref.moduleId, ref.side, ref.index);
    return (phases && phases.get(portId)) || null;
  }

  // Порт физически занят, только если к нему подключён провод. Унаследованная
  // фаза (клемма модуля без провода) занятой не считается — от неё как раз
  // и продолжают цепочку.
  function isPortConnected(ref, occupancy) {
    if (!ref) return false;
    const map = occupancy || getPortOccupancy();
    return map.has(makePortId(ref.moduleId, ref.side, ref.index));
  }

  // Тип, который обязан получить новый провод: он уже определён первой
  // клеммой либо унаследован модулем клеммы второй.
  function draftWireType(phases) {
    const map = phases || computePortPhases();
    return getPortPhase(activePort, map) || getPortPhase(pendingWire, map) || null;
  }

  // Проверка совместимости двух клемм перед созданием провода.
  // Возвращает { ok: true, phase } либо { ok: false, message }.
  function validatePortPair(first, second, phases) {
    const map = phases || computePortPhases();

    if (isPortConnected(second)) {
      const connected = getPortPhase(second, map);
      return {
        ok: false,
        message: connected
          ? `Этот порт уже занят фазой ${connected}`
          : 'Этот порт уже занят'
      };
    }

    const firstPhase = getPortPhase(first, map);
    const secondPhase = getPortPhase(second, map);

    // Шина принимает только свой тип: N — только N, PE — только PE.
    // Фазировка шин задана заранее (см. computePortPhases), но проверяем
    // явно, чтобы сообщение об ошибке было понятным.
    const firstBus = busbarTypeForRef(first);
    const secondBus = busbarTypeForRef(second);
    const busType = firstBus || secondBus;
    if (busType) {
      const otherPhase = firstBus ? secondPhase : firstPhase;
      if (otherPhase && otherPhase !== busType) {
        return {
          ok: false,
          message: `Ошибка фазировки! К шине ${busType} можно подключать только провод ${busType}`
        };
      }
      if (firstBus && secondBus && firstBus !== secondBus) {
        return {
          ok: false,
          message: `Ошибка фазировки! Нельзя соединить шины ${firstBus} и ${secondBus}`
        };
      }
    }

    if (firstPhase && secondPhase && firstPhase !== secondPhase) {
      return {
        ok: false,
        message: `Ошибка фазировки! Нельзя соединить ${firstPhase} и ${secondPhase}`
      };
    }

    return { ok: true, phase: firstPhase || secondPhase || null };
  }

  function getWireCounts() {
    const counts = {};
    for (const key of WIRE_TYPE_KEYS) counts[key] = 0;
    for (const connection of project.connections) {
      if (WIRE_TYPES[connection.type]) counts[connection.type] += 1;
    }
    return counts;
  }

  // Длина одной SVG-полилинии в пикселях схемы: сумма длин всех сегментов.
  function polylineLengthPx(polyline) {
    if (!polyline) return 0;
    const points = polyline.points;
    if (!points || points.numberOfItems < 2) return 0;

    let total = 0;
    for (let index = 1; index < points.numberOfItems; index += 1) {
      const previous = points.getItem(index - 1);
      const current = points.getItem(index);
      total += Math.sqrt(
        Math.pow(current.x - previous.x, 2) + Math.pow(current.y - previous.y, 2)
      );
    }
    return total;
  }

  // Расход кабеля по типам. Для каждого провода берём фактическую полилинию
  // с холста (она уже в координатах viewBox), переводим пиксели в метры по
  // масштабу DIN-модуля и добавляем технологический запас. Округление —
  // до 0.1 м, как принято в спецификации.
  function calculateWireLengths() {
    const pixels = {};
    for (const key of WIRE_TYPE_KEYS) pixels[key] = 0;

    const polylines = new Map();
    if (dom.wireLayer) {
      dom.wireLayer.querySelectorAll('polyline[data-connection-id]').forEach((polyline) => {
        polylines.set(polyline.getAttribute('data-connection-id'), polyline);
      });
    }

    for (const connection of project.connections) {
      const typeKey = WIRE_TYPES[connection.type] ? connection.type : DEFAULT_WIRE_TYPE;
      pixels[typeKey] += polylineLengthPx(polylines.get(connection.id));
    }

    const lengths = {};
    for (const key of WIRE_TYPE_KEYS) {
      const meters = (pixels[key] / PIXELS_PER_METER) * WIRE_LENGTH_RESERVE;
      lengths[key] = Math.round(meters * 10) / 10;
    }
    return lengths;
  }

  function formatCableLength(meters) {
    return `${meters.toFixed(1)} м`;
  }

  function updateDocumentTitle() {
    const name = project.name.trim() || 'Новый щит';
    document.title = `${name} — Щит.Студия`;
  }

  /* --------------------------- Power flow ----------------------------- */

  // Обход графа «порт → провод → модуль → порт». Список активных портов
  // пополняется до неподвижной точки. Провод под напряжением, если активны
  // оба его конца; результат пишется в connection.isLive.
  function calculatePowerFlow() {
    const activePorts = new Set();

    // a) Главный рубильник включён — все пять портов источника под напряжением.
    if (project?.source?.isOn !== false) {
      for (let index = 0; index < POWER_SOURCE.ports.length; index += 1) {
        activePorts.add(makePortId(POWER_SOURCE.id, 'bottom', index));
      }
    }

    const modules = allModules();
    let changed = true;

    while (changed) {
      changed = false;

      // b) Провод проводит потенциал в обе стороны — направление кликов
      // не должно влиять на результат симуляции.
      for (const connection of project.connections) {
        const fromPort = makePortId(
          connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex
        );
        const toPort = makePortId(
          connection.toModuleId, connection.toPortSide, connection.toPortIndex
        );
        const fromActive = activePorts.has(fromPort);
        const toActive = activePorts.has(toPort);
        if (fromActive === toActive) continue;
        activePorts.add(fromActive ? toPort : fromPort);
        changed = true;
      }

      // c) Модуль с включённым рычажком проводит потенциал на другую грань.
      for (const module of modules) {
        if (module.isOn === false) continue;
        const counts = portsForModule(module);
        let topLive = false;
        let bottomLive = false;

        for (let index = 0; index < counts.top; index += 1) {
          if (activePorts.has(makePortId(module.id, 'top', index))) {
            topLive = true;
            break;
          }
        }
        for (let index = 0; index < counts.bottom; index += 1) {
          if (activePorts.has(makePortId(module.id, 'bottom', index))) {
            bottomLive = true;
            break;
          }
        }

        if (topLive && !bottomLive) {
          for (let index = 0; index < counts.bottom; index += 1) {
            const portId = makePortId(module.id, 'bottom', index);
            if (!activePorts.has(portId)) {
              activePorts.add(portId);
              changed = true;
            }
          }
        }
        if (bottomLive && !topLive) {
          for (let index = 0; index < counts.top; index += 1) {
            const portId = makePortId(module.id, 'top', index);
            if (!activePorts.has(portId)) {
              activePorts.add(portId);
              changed = true;
            }
          }
        }
      }

      // d) Шина: достаточно одного активного порта — ток растекается
      //    мгновенно по ВСЕМ клеммам, верхним и нижним.
      for (const module of modules) {
        if (!isBusbarModule(module) || !moduleHasLivePort(module, activePorts)) continue;
        const counts = portsForModule(module);
        for (const side of PORT_SIDES) {
          for (let index = 0; index < counts[side]; index += 1) {
            const portId = makePortId(module.id, side, index);
            if (!activePorts.has(portId)) {
              activePorts.add(portId);
              changed = true;
            }
          }
        }
      }
    }

    // Сохраняем для рендера: по этим портам подсвечиваются клеммы шин.
    livePorts = activePorts;

    // ---------------------------------------------------------------------
    // Расчёт тока, напряжения и мощности.
    // Каждая включённая нагрузка потребляет I = P / 230 (однофазная сеть).
    // Ток «поднимается» от нагрузки к источнику по дереву обхода графа,
    // складываясь на общих участках цепи. Результат пишется в провода
    // (current / voltage) и модули (current), чтобы его можно было показать
    // на схеме и проверить перегрузку защитных аппаратов.
    // ---------------------------------------------------------------------
    for (const connection of project.connections) {
      const fromPort = makePortId(
        connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex
      );
      const toPort = makePortId(
        connection.toModuleId, connection.toPortSide, connection.toPortIndex
      );
      connection.isLive = activePorts.has(fromPort) && activePorts.has(toPort);
      const isReturnWire = connection.type === 'N' || connection.type === 'PE';
      connection.voltage = connection.isLive && !isReturnWire ? NOMINAL_VOLTAGE : 0;
      connection.current = 0;
      connection.overloaded = false;
      connection.ratedLimit = null;
    }
    for (const module of modules) {
      module.current = 0;
      module.overloaded = false;
    }

    // Граф: вершины — активные клеммы, рёбра — провода и внутренние
    // соединения модулей (у шин все клеммы соединены между собой).
    const adjacency = new Map();
    const addEdge = (edge, a, b) => {
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a).push({ edge, to: b });
      adjacency.get(b).push({ edge, to: a });
    };

    for (const connection of project.connections) {
      if (!connection.isLive) continue;
      const a = makePortId(
        connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex
      );
      const b = makePortId(
        connection.toModuleId, connection.toPortSide, connection.toPortIndex
      );
      addEdge({ kind: 'wire', ref: connection, rating: null }, a, b);
    }

    for (const module of modules) {
      if (module.isOn === false) continue;
      const counts = portsForModule(module);
      const rating = protectiveRating(module);
      const livePortsOf = (side) => {
        const result = [];
        for (let index = 0; index < counts[side]; index += 1) {
          const id = makePortId(module.id, side, index);
          if (activePorts.has(id)) result.push(id);
        }
        return result;
      };

      const groups = [];
      if (isBusbarModule(module)) {
        const all = PORT_SIDES.flatMap((side) => livePortsOf(side));
        if (all.length > 1) groups.push(all);
      } else {
        const top = livePortsOf('top');
        const bottom = livePortsOf('bottom');
        if (top.length && bottom.length) {
          for (const a of top) {
            for (const b of bottom) {
              addEdge({ kind: 'module', ref: module, rating }, a, b);
            }
          }
        } else {
          const all = [...top, ...bottom];
          if (all.length > 1) groups.push(all);
        }
      }
      for (const group of groups) {
        for (let i = 0; i < group.length; i += 1) {
          for (let j = i + 1; j < group.length; j += 1) {
            addEdge({ kind: 'module', ref: module, rating }, group[i], group[j]);
          }
        }
      }
    }

    // Дерево обхода от источника: по нему ток каждой нагрузки идёт наверх.
    const roots = [];
    if (project?.source?.isOn !== false) {
      for (let index = 0; index < POWER_SOURCE.ports.length; index += 1) {
        const id = makePortId(POWER_SOURCE.id, 'bottom', index);
        if (activePorts.has(id)) roots.push(id);
      }
    }
    const visited = new Set(roots);
    const parent = new Map();
    const bfsOrder = roots.slice();
    const queue = roots.slice();
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const node = queue[cursor];
      for (const link of adjacency.get(node) || []) {
        if (visited.has(link.to)) continue;
        visited.add(link.to);
        parent.set(link.to, { edge: link.edge, from: node });
        bfsOrder.push(link.to);
        queue.push(link.to);
      }
    }

    // Заявки нагрузок: I = P / 230. Мощность нормализуется и сохраняется
    // в модуле, чтобы двойной клик и JSON-экспорт работали с одним значением.
    const demand = [];
    for (const module of modules) {
      if (!isLoadModule(module) || module.isOn === false) continue;
      module.power = normalizeLoadPower(module.power, DEFAULT_LOAD_POWER);
      if (!moduleHasLivePort(module, activePorts)) continue;

      const counts = portsForModule(module);
      let entryPort = null;
      for (let index = 0; index < counts.top && !entryPort; index += 1) {
        const id = makePortId(module.id, 'top', index);
        if (activePorts.has(id)) entryPort = id;
      }
      if (!entryPort) {
        for (const side of PORT_SIDES) {
          for (let index = 0; index < counts[side]; index += 1) {
            const id = makePortId(module.id, side, index);
            if (activePorts.has(id)) { entryPort = id; break; }
          }
          if (entryPort) break;
        }
      }

      const amps = module.power / NOMINAL_VOLTAGE;
      module.current = amps;
      if (entryPort && visited.has(entryPort)) demand.push([entryPort, amps]);
    }

    // Поднимаем ток по дереву от нагрузки к источнику и складываем его
    // на всех пройденных рёбрах (провадах и внутренних переходах модулей).
    for (const [portId, amps] of demand) {
      let node = portId;
      while (parent.has(node)) {
        const step = parent.get(node);
        step.edge.ref.current = (Number(step.edge.ref.current) || 0) + amps;
        node = step.from;
      }
    }
    for (const connection of project.connections) {
      connection.current = Math.round((Number(connection.current) || 0) * 100) / 100;
    }
    for (const module of modules) {
      module.current = Math.round((Number(module.current) || 0) * 100) / 100;
    }

    // Предел тока для провода — минимальный номинал защитного аппарата
    // выше по цепи. Превышение окрашивает плашку провода в красный.
    const nodeLimit = new Map();
    for (const node of bfsOrder) {
      const step = parent.get(node);
      let limit = Infinity;
      if (step) {
        const parentLimit = nodeLimit.get(step.from);
        limit = step.edge.rating ? Math.min(parentLimit, step.edge.rating) : parentLimit;
        if (step.edge.kind === 'wire' && Number.isFinite(limit)) {
          step.edge.ref.ratedLimit = limit;
        }
      }
      nodeLimit.set(node, limit);
    }
    for (const connection of project.connections) {
      const limit = connection.ratedLimit;
      connection.overloaded = Boolean(limit) && connection.current > limit + 0.001;
    }
    for (const module of modules) {
      const rating = protectiveRating(module);
      module.overloaded = Boolean(rating) && module.current > rating + 0.001;
    }

    return activePorts;
  }

  function isSimulationOn() {
    return project?.simulation !== false;
  }

  function isShowingParams() {
    return project?.showParams !== false;
  }

  /* -------------------------- Project factories ------------------------ */

  function createRail(modules = []) {
    return { id: makeId('rail'), capacity: RAIL.capacity, modules };
  }

  // Настройки слоёв: видимость и блокировка. Значения по умолчанию —
  // все слои видны и разблокированы.
  function createLayerSettings() {
    const settings = {};
    for (const key of LAYER_KEYS) settings[key] = { visible: true, locked: false };
    return settings;
  }

  // Приводит сохранённые/импортированные настройки к валидному виду:
  // неизвестные слои отбрасываются, отсутствующие получают значения по умолчанию.
  function normalizeLayerSettings(raw) {
    const settings = createLayerSettings();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return settings;
    for (const key of LAYER_KEYS) {
      const value = raw[key];
      if (!value || typeof value !== 'object') continue;
      settings[key].visible = value.visible !== false;
      settings[key].locked = value.locked === true;
    }
    return settings;
  }

  function createEmptyProject(name = 'Новый щит') {
    return {
      id: makeId('prj'),
      name,
      rails: [createRail()],
      connections: [],
      // Стикеры свободно лежат на холсте: они не привязаны к рейке и хранят
      // только текст и координаты в системе viewBox.
      notes: [],
      source: { isOn: true },
      simulation: true,
      showParams: true,
      // Видимость и блокировка переключаемых слоёв (Провода/Модули/Подписи).
      // Рейки и источник питания — не слои и здесь не хранятся.
      layerSettings: createLayerSettings(),
      // Введённые вручную цены: { [id элемента библиотеки]: число }.
      customPrices: {},
      // Кастомные цены за метр кабеля: { L1: 65, N: 50, ... }.
      customCablePrices: {},
      // Наклейки маркировки и настройки печатного листа. Наклейки
      // синхронизируются с модулями и проводами через syncMarkings().
      markings: [],
      markingSettings: createMarkingSettings(),
      updatedAt: new Date().toISOString()
    };
  }

  function createModuleFromLibrary(libraryItem, tag) {
    return {
      id: makeId('mod'),
      libraryId: libraryItem.id,
      type: libraryItem.type,
      name: libraryItem.name,
      width: libraryItem.width,
      slot: 0,
      color: libraryItem.color,
      ports: portsForModule(libraryItem),
      isBusbar: libraryItem.isBusbar === true,
      busType: libraryItem.busType || null,
      busbarType: libraryItem.busType || libraryItem.busbarType || null,
      tag: tag || generateTag(libraryItem.tagPrefix, project ? allModules() : []),
      isOn: true,
      power: normalizeLoadPower(libraryItem.power, DEFAULT_LOAD_POWER),
      description: ''
    };
  }

  function createDemoProject() {
    const demo = createEmptyProject('Щит ЩР-1');
    const demoItems = [
      ['incoming-breaker-2p', 'QF1'],
      ['breaker-3p', 'QF2'],
      ['rcd', 'QS1'],
      ['contactor', 'KM1'],
      ['voltage-relay', 'KV1'],
      ['terminal', 'XT1']
    ];

    let demoSlot = 0;
    demo.rails[0].modules = demoItems.map(([libraryId, tag]) => {
      const libraryItem = LIBRARY_BY_ID.get(libraryId);
      const slot = demoSlot;
      demoSlot += libraryItem.width;
      return {
        id: makeId('mod'),
        libraryId: libraryItem.id,
        type: libraryItem.type,
        name: libraryItem.name,
        width: libraryItem.width,
        slot,
        color: libraryItem.color,
        ports: portsForModule(libraryItem),
        isBusbar: libraryItem.isBusbar === true,
        busType: libraryItem.busType || null,
        busbarType: libraryItem.busType || libraryItem.busbarType || null,
        tag,
        isOn: true,
        power: normalizeLoadPower(libraryItem.power, DEFAULT_LOAD_POWER),
        description: ''
      };
    });

    const [incoming, breaker, rcd, contactor, , terminal] = demo.rails[0].modules;
    const demoWires = [
      [POWER_SOURCE, 'bottom', 0, incoming, 'top', 0, 'L1'],
      [POWER_SOURCE, 'bottom', 1, contactor, 'top', 0, 'L2'],
      [POWER_SOURCE, 'bottom', 2, contactor, 'top', 1, 'L3'],
      [POWER_SOURCE, 'bottom', 3, incoming, 'top', 1, 'N'],
      [incoming, 'bottom', 0, breaker, 'top', 0, 'L1'],
      [incoming, 'bottom', 1, breaker, 'top', 1, 'N'],
      [breaker, 'bottom', 0, rcd, 'top', 0, 'L1'],
      [breaker, 'bottom', 1, rcd, 'top', 1, 'N'],
      [POWER_SOURCE, 'bottom', 4, terminal, 'top', 0, 'PE']
    ];
    demo.connections = demoWires.map(([
      fromModule, fromPortSide, fromPortIndex, toModule, toPortSide, toPortIndex, type
    ]) => ({
      id: makeId('conn'),
      fromModuleId: fromModule.id,
      fromPortSide,
      fromPortIndex,
      fromRailId: fromModule.isPowerSource ? null : demo.rails[0].id,
      toModuleId: toModule.id,
      toPortSide,
      toPortIndex,
      toRailId: toModule.isPowerSource ? null : demo.rails[0].id,
      type,
      color: WIRE_TYPES[type].color,
      label: ''
    }));

    return demo;
  }

  // Приводит слоты модулей к корректным значениям: без выхода за рейку
  // и без наложений. Вызывается после всех структурных изменений.
  function normalizeSlots() {
    project.rails.forEach((rail) => {
      const used = new Set();
      rail.modules.forEach((module) => {
        let slot = clampSlot(rail, module.slot, module.width);
        if (!rangeIsFree(used, slot, module.width)) {
          const free = firstFreeSlot(used, module.width, rail.capacity);
          slot = free === null ? clampSlot(rail, module.slot, module.width) : free;
        }
        module.slot = slot;
        for (let offset = 0; offset < module.width; offset += 1) used.add(slot + offset);
      });
    });
  }

  /* -------------------------- Project validation ----------------------- */

  // Кастомные цены приходят из localStorage или импортированного JSON.
  // Оставляем только конечные неотрицательные числа с безопасной точностью.
  function normalizeCustomPrices(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key !== 'string' || !key || key.length > 120) continue;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CUSTOM_PRICE) continue;
      result[key] = roundMoney(parsed);
    }
    return result;
  }

  // Цены кабелей хранятся отдельно от цен модулей и ключуются типом
  // проводника (L1, L2, L3, N, PE). Незнакомые типы из JSON отбрасываются.
  function normalizeCustomCablePrices(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    for (const key of WIRE_TYPE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      const parsed = Number(raw[key]);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CUSTOM_PRICE) continue;
      result[key] = roundMoney(parsed);
    }
    return result;
  }

  // Стикеры из localStorage / импортированного JSON. Координаты ограничиваем
  // разумным диапазоном, чтобы повреждённый файл не увёл заметку за пределы
  // холста и не сломал экспорт PNG (getBBox считается по реальным элементам).
  function normalizeNotes(raw) {
    if (!Array.isArray(raw)) return [];
    const usedIds = new Set();
    const notes = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      let id = safeId(item.id);
      if (!id || usedIds.has(id)) id = makeId('note');
      usedIds.add(id);

      const x = Number(item.x);
      const y = Number(item.y);
      notes.push({
        id,
        text: safeText(item.text, '', MAX_NOTE_TEXT_LENGTH),
        x: Number.isFinite(x) ? clamp(x, -2000, 4000) : 40,
        y: Number.isFinite(y) ? clamp(y, -2000, 4000) : 40
      });
    }
    return notes;
  }

  function normalizeProject(raw, options = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const capacity = RAIL.capacity;
    const usedIds = new Set();
    const usedTags = new Set();
    const reservedTags = new Set();
    const normalizedModules = [];

    const rawRails = Array.isArray(raw.rails) ? raw.rails : null;
    const flatModules = Array.isArray(raw.modules) ? raw.modules : [];

    function rememberTags(modules) {
      for (const rawModule of modules) {
        const tag = safeTag(rawModule?.tag);
        if (tag) reservedTags.add(tag.toUpperCase());
      }
    }
    if (rawRails) {
      rawRails.forEach((rail) => rememberTags(Array.isArray(rail?.modules) ? rail.modules : []));
    } else {
      rememberTags(flatModules);
    }

    function normalizeModules(rawModules, railCapacity = capacity) {
      const modules = [];
      const usedSlots = new Set();
      const limit = clamp(Math.round(railCapacity) || capacity, MIN_RAIL_CAPACITY, MAX_RAIL_CAPACITY);

      // Миграция v4 -> v5: если у модулей есть slot — используем его.
      // Иначе восстанавливаем слоты из order: order 0 -> 0,
      // order 1 -> 0 + ширина предыдущего, и т.д. (зазоры в старых
      // проектах отсутствовали, поэтому это однозначное преобразование).
      const hasExplicitSlots = rawModules.some((item) => item && Number.isInteger(item.slot));
      const source = hasExplicitSlots
        ? rawModules.slice()
        : rawModules
            .map((item, index) => ({ item, index }))
            .sort((a, b) => {
              const aOrder = Number(a.item?.order);
              const bOrder = Number(b.item?.order);
              if (Number.isFinite(aOrder) && Number.isFinite(bOrder) && aOrder !== bOrder) {
                return aOrder - bOrder;
              }
              return a.index - b.index;
            })
            .map((entry) => entry.item);
      let legacyCursor = 0;

      for (const rawModule of source) {
        if (!rawModule || typeof rawModule !== 'object') continue;
        // Источник питания — закреплённый элемент интерфейса, а не модуль.
        // Старые сохранения могли держать его в рейках: в проект не берём.
        if (rawModule.isPowerSource === true || rawModule.id === POWER_SOURCE.id) continue;

        const rawLibraryId = safeText(rawModule.libraryId, '', 40);
        const libraryItem = LIBRARY_BY_ID.get(rawLibraryId);
        const parsedWidth = Number(rawModule.width);
        const width = Number.isFinite(parsedWidth)
          ? clamp(Math.round(parsedWidth), 1, 6)
          : (libraryItem?.width || 1);

        let slot;
        if (hasExplicitSlots) {
          const parsedSlot = Number(rawModule.slot);
          slot = Number.isInteger(parsedSlot)
            ? clamp(parsedSlot, 0, Math.max(0, limit - width))
            : null;
          if (slot === null || !rangeIsFree(usedSlots, slot, width)) {
            slot = firstFreeSlot(usedSlots, width, limit);
          }
        } else {
          slot = legacyCursor;
        }
        if (slot === null || slot + width > limit) break;

        let id = safeId(rawModule.id);
        if (!id || usedIds.has(id)) id = makeId('mod');

        const name = safeText(rawModule.name, libraryItem?.name || 'Модуль', 40);
        const type = safeText(rawModule.type, libraryItem?.type || 'other', 24);
        const color = safeColor(rawModule.color) ||
          libraryItem?.color ||
          WIRE_COLORS[normalizedModules.length % WIRE_COLORS.length];

        let tag = safeTag(rawModule.tag);
        if (!tag || usedTags.has(tag.toUpperCase())) {
          const tagPrefix = libraryItem?.tagPrefix ||
            (tag.match(/^[A-Za-zА-Яа-я]{1,4}/u)?.[0]) ||
            'M';
          tag = generateTag(tagPrefix, normalizedModules, reservedTags);
        }
        usedTags.add(tag.toUpperCase());
        reservedTags.add(tag.toUpperCase());

        const libraryId = libraryItem?.id || rawLibraryId || 'misc';
        const ports = portsForModule({ ports: rawModule.ports, libraryId, width });

        usedIds.add(id);
        for (let offset = 0; offset < width; offset += 1) usedSlots.add(slot + offset);
        const module = {
          id,
          libraryId,
          type,
          name,
          width,
          slot,
          color,
          ports,
          isBusbar: rawModule.isBusbar === true || libraryItem?.isBusbar === true,
          busType: rawModule.busType || libraryItem?.busType || null,
          busbarType: rawModule.busType || rawModule.busbarType ||
            libraryItem?.busType || libraryItem?.busbarType || null,
          tag,
          isOn: rawModule.isOn !== false,
          power: normalizeLoadPower(
            rawModule.power !== undefined ? rawModule.power : libraryItem?.power,
            DEFAULT_LOAD_POWER
          ),
          description: safeText(rawModule.description, '', MAX_MODULE_DESCRIPTION_LENGTH),
          // groupId сохраняется при импорте и загрузке из localStorage.
          groupId: safeGroupId(rawModule.groupId) || undefined
        };
        modules.push(module);
        normalizedModules.push(module);
        if (!hasExplicitSlots) legacyCursor = slot + width;
      }
      return modules;
    }

    const rails = [];
    if (rawRails) {
      const usedRailIds = new Set();
      for (const rawRail of rawRails) {
        let id = safeId(rawRail?.id);
        if (!id || usedRailIds.has(id)) id = makeId('rail');
        usedRailIds.add(id);
        const parsedCapacity = Number(rawRail?.capacity);
        const railCapacity = Number.isFinite(parsedCapacity)
          ? clamp(Math.round(parsedCapacity), MIN_RAIL_CAPACITY, MAX_RAIL_CAPACITY)
          : capacity;
        rails.push({
          id,
          capacity: railCapacity,
          modules: normalizeModules(
            Array.isArray(rawRail?.modules) ? rawRail.modules : [],
            railCapacity
          )
        });
      }
    } else {
      // v1/v2 -> v4: все модули едут в первую рейку; при переполнении — в следующую.
      let rest = flatModules;
      while (rest.length > 0) {
        const modules = normalizeModules(rest);
        if (modules.length === 0) break;
        rails.push({ id: makeId('rail'), capacity, modules });
        rest = rest.slice(modules.length);
      }
    }
    if (rails.length === 0) rails.push(createRail());

    const moduleLookup = new Map(normalizedModules.map((module) => [module.id, module]));
    const railLookup = new Map();
    rails.forEach((rail) => rail.modules.forEach((module) => railLookup.set(module.id, rail.id)));
    const connections = [];
    const seenConnections = new Set();
    const usedConnectionIds = new Set();

    // v1-документы (в том числе без schemaVersion) приходят без портов у связей.
    // Модули сохраняем, а провода сбрасываем и показываем одноразовый баннер.
    const rawConnections = options.dropConnections
      ? []
      : (Array.isArray(raw.connections) ? raw.connections : []);

    for (const rawConnection of rawConnections) {
      if (!rawConnection || typeof rawConnection !== 'object') continue;

      const fromModuleId = safeText(rawConnection.fromModuleId, '', 80);
      const toModuleId = safeText(rawConnection.toModuleId, '', 80);
      const fromModule = moduleLookup.get(fromModuleId) ||
        (fromModuleId === POWER_SOURCE.id ? POWER_SOURCE : null);
      const toModule = moduleLookup.get(toModuleId) ||
        (toModuleId === POWER_SOURCE.id ? POWER_SOURCE : null);
      if (!fromModule || !toModule || fromModuleId === toModuleId) continue;
      // У источника питания порты только снизу.
      if (fromModule.isPowerSource && rawConnection.fromPortSide !== 'bottom') continue;
      if (toModule.isPowerSource && rawConnection.toPortSide !== 'bottom') continue;

      const fromPortSide = isPortSide(rawConnection.fromPortSide) ? rawConnection.fromPortSide : 'top';
      const toPortSide = isPortSide(rawConnection.toPortSide) ? rawConnection.toPortSide : 'top';
      const fromPortIndex = normalizePortIndex(rawConnection.fromPortIndex, fromModule, fromPortSide);
      const toPortIndex = normalizePortIndex(rawConnection.toPortIndex, toModule, toPortSide);

      const portKey = [
        makePortId(fromModuleId, fromPortSide, fromPortIndex),
        makePortId(toModuleId, toPortSide, toPortIndex)
      ].sort().join('|');
      if (seenConnections.has(portKey)) continue;

      let id = safeId(rawConnection.id);
      if (!id || usedConnectionIds.has(id)) id = makeId('conn');

      const storedColor = safeColor(rawConnection.color);
      const storedType = typeof rawConnection.type === 'string' ? rawConnection.type : '';
      const aliasedType = LEGACY_WIRE_TYPES[storedType] || storedType;
      const type = WIRE_TYPES[aliasedType]
        ? aliasedType
        : (WIRE_TYPE_KEYS.find((key) => WIRE_TYPES[key].color === storedColor) ||
          LEGACY_WIRE_COLORS[storedColor] ||
          DEFAULT_WIRE_TYPE);

      seenConnections.add(portKey);
      usedConnectionIds.add(id);
      connections.push({
        id,
        fromModuleId,
        fromPortSide,
        fromPortIndex,
        fromRailId: railLookup.get(fromModuleId) || null,
        toModuleId,
        toPortSide,
        toPortIndex,
        toRailId: railLookup.get(toModuleId) || null,
        type,
        color: WIRE_TYPES[type].color,
        label: safeText(rawConnection.label, '', MAX_WIRE_LABEL_LENGTH)
      });
    }

    return {
      id: safeId(raw.id) || makeId('prj'),
      name: safeText(raw.name, 'Новый щит', 60),
      rails,
      connections,
      notes: normalizeNotes(raw.notes),
      source: { isOn: raw.source?.isOn !== false },
      simulation: raw.simulation !== false,
      showParams: raw.showParams !== false,
      layerSettings: normalizeLayerSettings(raw.layerSettings),
      customPrices: normalizeCustomPrices(raw.customPrices),
      customCablePrices: normalizeCustomCablePrices(raw.customCablePrices),
      markings: normalizeMarkings(raw.markings),
      markingSettings: normalizeMarkingSettings(raw.markingSettings),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
    };
  }

  /* ----------------------------- Storage ------------------------------ */

  function setSaveState(state) {
    if (!dom.saveState) return;
    const isError = state === 'error';
    const message = isError ? 'Не удалось сохранить' : 'Сохранено локально';
    dom.saveState.classList.toggle('is-error', isError);
    dom.saveText.textContent = message;
    // На ноутбуках подпись статуса скрыта — подсказка остаётся на иконке.
    dom.saveState.title = message;
  }

  // На экранах ≤1440 px подписи кнопок шапки (.btn-text) скрываются,
  // поэтому у каждой такой кнопки должна быть подсказка title.
  function ensureIconButtonTitles() {
    document.querySelectorAll('.topbar .btn-text').forEach((label) => {
      const button = label.closest('button');
      if (button && !button.getAttribute('title')) {
        button.title = label.textContent.trim();
      }
    });
  }

  function announceStorageError() {
    if (storageErrorAnnounced) return;
    storageErrorAnnounced = true;
    showToast('Браузер не разрешает localStorage. Изменения не сохранятся.', 'error', 5000);
  }

  function persistProject() {
    project.updatedAt = new Date().toISOString();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        project
      }));
      setSaveState('saved');
      return true;
    } catch (error) {
      setSaveState('error');
      announceStorageError();
      return false;
    }
  }

  function bootProject() {
    let raw = null;
    let readFailed = false;

    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      readFailed = true;
    }

    if (readFailed) {
      project = createDemoProject();
      setSaveState('error');
      bootNotices.push(['Локальное хранилище недоступно. Проект не будет сохранён.', 'error']);
      return;
    }

    if (!raw) {
      project = createDemoProject();
      persistProject();
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const storedVersion = Number(parsed?.schemaVersion);
      const candidate = parsed && typeof parsed === 'object' && parsed.project ? parsed.project : parsed;
      const candidateModules = candidate && Array.isArray(candidate.rails)
        ? candidate.rails.reduce((items, rail) =>
            items.concat(Array.isArray(rail?.modules) ? rail.modules : []), [])
        : (candidate && Array.isArray(candidate.modules) ? candidate.modules : []);
      const seenTags = new Set();
      const needsTagMigration = candidateModules.some((module) => {
        const tag = safeTag(module?.tag);
        if (!tag) return true;
        const normalizedTag = tag.toUpperCase();
        if (seenTags.has(normalizedTag)) return true;
        seenTags.add(normalizedTag);
        return false;
      });

      // Только v1-документы (без schemaVersion) теряют провода — для них
      // показывается одноразовый баннер. v2 -> v4 сохраняет связи: модули
      // переезжают в rails[0], провода остаются на месте.
      const needsWireMigration = !Number.isFinite(storedVersion) || storedVersion < 2;
      const needsSchemaMigration = storedVersion !== SCHEMA_VERSION;
      const needsSwitchMigration = candidateModules.some((module) => typeof module?.isOn !== 'boolean');
      const normalized = normalizeProject(candidate, { dropConnections: needsWireMigration });
      if (!normalized) throw new Error('Invalid project data');
      project = normalized;

      if (needsWireMigration) {
        showMigrationBanner = true;
        migrationNotice = MIGRATION_NOTICE;
      } else if (needsSchemaMigration) {
        showMigrationBanner = true;
        migrationNotice = Number.isFinite(storedVersion) && storedVersion < 6
          ? 'Проект обновлён: добавлены мощность нагрузки и параметры сети (В / А / Вт)'
          : 'Проект обновлён: порядок модулей заменён слотами, пустые места сохраняются';
      }
      if (needsWireMigration || needsTagMigration || needsSchemaMigration || needsSwitchMigration) persistProject();
      else setSaveState('saved');
    } catch (error) {
      project = createDemoProject();
      persistProject();
      bootNotices.push(['Сохранённый проект повреждён — загружен демонстрационный.', 'error']);
    }
  }

  /* ------------------------------ History ----------------------------- */

  function cloneHistoryState() {
    // Структурные данные проекта — обычные объекты/массивы, поэтому JSON
    // даёт независимую копию без ссылок на живой проект.
    return JSON.parse(JSON.stringify({
      rails: project.rails,
      connections: project.connections,
      notes: notes(),
      source: project.source || { isOn: true },
      layerSettings: project.layerSettings || createLayerSettings(),
      markings: markings(),
      markingSettings: markingSettings()
    }));
  }

  function updateHistoryButtons() {
    if (dom.undoBtn) dom.undoBtn.disabled = historyIndex <= 0;
    if (dom.redoBtn) dom.redoBtn.disabled = historyIndex >= history.length - 1;
  }

  function resetHistory() {
    history = [cloneHistoryState()];
    historyIndex = 0;
    updateHistoryButtons();
  }

  function commitHistory() {
    const next = cloneHistoryState();
    if (historyIndex >= 0 && history[historyIndex] &&
        JSON.stringify(history[historyIndex]) === JSON.stringify(next)) {
      return;
    }

    // Любое новое действие после Undo отбрасывает «ветку» будущего.
    history.length = historyIndex + 1;
    history.push(next);
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
  }

  function applyHistoryState(index) {
    const state = history[index];
    if (!state || !project) return false;

    const restored = JSON.parse(JSON.stringify(state));
    project.rails = restored.rails;
    project.connections = restored.connections;
    project.notes = normalizeNotes(restored.notes);
    if (selectedNoteId && !noteById(selectedNoteId)) selectedNoteId = null;
    project.source = restored.source || project.source || { isOn: true };
    project.layerSettings = normalizeLayerSettings(restored.layerSettings);
    project.markings = normalizeMarkings(restored.markings);
    project.markingSettings = normalizeMarkingSettings(restored.markingSettings);
    if (selectedMarkingId && !markings().some((item) => item.id === selectedMarkingId)) {
      selectedMarkingId = null;
      closeMarkingEditor();
    }

    resetInteractionState();
    clearConnectionDraft();
    clearSelection();
    selectedConnectionId = null;
    suppressCanvasClickUntil = performance.now() + 250;

    // В localStorage уходит только текущее состояние, история не сохраняется.
    persistProject();
    renderAll();
    updateHistoryButtons();
    return true;
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    if (applyHistoryState(historyIndex)) showToast('Действие отменено', 'success', 1600);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    if (applyHistoryState(historyIndex)) showToast('Действие повторено', 'success', 1600);
  }

  /* ----------------------------- Rendering ---------------------------- */

  function libraryCardMarkup(item) {
    const category = LIBRARY_CATEGORY_BY_ID.get(item.category);
    const moduleLabel = `${item.width} ${plural(item.width, ['модуль', 'модуля', 'модулей'])}`;
    const details = [
      item.description,
      item.brand ? `Бренд: ${item.brand}` : '',
      item.sku ? `Артикул: ${item.sku}` : ''
    ].filter(Boolean).join(' · ');
    return `
      <button class="component-card" type="button" data-library-id="${escapeHtml(item.id)}"
              style="--component-color:${item.color}"
              title="${escapeHtml(details)}"
              aria-label="${escapeHtml(`${item.name}, категория ${category?.label || '—'}, тег ${item.tagPrefix}, ширина ${moduleLabel}. ${details} Перетащите на рейку или нажмите, чтобы добавить.`)}">
        <span class="component-icon" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <rect class="component-icon-shell" x="5.5" y="7.5" width="21" height="17" rx="3.2"/>
            <path class="component-icon-circuit" d="M10.5 11v10M16 11v10M21.5 11v10M10.5 16h11"/>
          </svg>
        </span>
        <span class="component-copy">
          <span class="component-name">${escapeHtml(item.name)}</span>
          <span class="component-meta">
            <span class="component-prefix">${escapeHtml(item.tagPrefix)}</span>
            <span class="meta-sep" aria-hidden="true">·</span>
            <span class="component-width">${item.width}P</span>
            <span class="meta-sep" aria-hidden="true">·</span>
            <span class="component-type">${escapeHtml(item.typeLabel)}</span>
          </span>
        </span>
        <span class="component-grip" aria-hidden="true"></span>
      </button>`;
  }

  function renderLibrary() {
    dom.libraryList.innerHTML = LIBRARY_CATEGORIES.map((category) => {
      const items = LIBRARY.filter((item) => item.category === category.id);
      const isOpen = libraryOpenState.has(category.id);
      if (isOpen) libraryOpenState.add(category.id);
      return `
        <details class="component-group" data-category="${escapeHtml(category.id)}" ${isOpen ? 'open' : ''}>
          <summary class="component-group-summary">
            <span class="component-group-title">${escapeHtml(category.label)}</span>
            <span class="component-group-side">
              <span class="component-group-count">${items.length}</span>
              <svg class="component-group-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
          </summary>
          <div class="component-group-body">
            ${items.map(libraryCardMarkup).join('')}
          </div>
        </details>`;
    }).join('');

    dom.libraryNoResults.hidden = true;
    dom.librarySearchStatus.textContent = '';
    updateLibraryCount();
  }

  function updateLibraryCount(visibleCount = null) {
    const count = visibleCount === null ? LIBRARY.length : visibleCount;
    const suffix = visibleCount === null ? '' : ` из ${LIBRARY.length}`;
    dom.libraryCount.textContent = `${count} ${plural(count, ['компонент', 'компонента', 'компонентов'])}${suffix}`;
  }

  function applyLibraryFilter(rawQuery) {
    const query = String(rawQuery || '').trim().toLocaleLowerCase('ru');
    isLibraryFiltering = Boolean(query);
    let visibleTotal = 0;

    dom.libraryList.querySelectorAll('.component-group').forEach((group) => {
      const category = LIBRARY_CATEGORY_BY_ID.get(group.dataset.category);
      const categoryMatches = Boolean(query) &&
        category?.label.toLocaleLowerCase('ru').includes(query);
      let groupMatches = 0;

      group.querySelectorAll('.component-card').forEach((card) => {
        const item = LIBRARY_BY_ID.get(card.dataset.libraryId);
        if (!item) return;

        const searchText = [
          item.name,
          category?.label || '',
          item.tagPrefix,
          item.typeLabel,
          item.brand,
          item.sku,
          item.description
        ].join(' ').toLocaleLowerCase('ru');
        const matches = !query || categoryMatches || searchText.includes(query);
        card.hidden = !matches;
        if (matches) groupMatches += 1;
      });

      group.hidden = Boolean(query) && groupMatches === 0;
      if (query) {
        group.open = groupMatches > 0;
      } else {
        group.open = libraryOpenState.has(group.dataset.category);
      }
      visibleTotal += groupMatches;
    });

    dom.libraryList.hidden = Boolean(query) && visibleTotal === 0;
    dom.libraryNoResults.hidden = !query || visibleTotal > 0;
    dom.librarySearchStatus.textContent = query
      ? (visibleTotal > 0 ? `Найдено: ${visibleTotal}` : 'Ничего не найдено')
      : '';
    dom.librarySearchClear.hidden = !query;
    updateLibraryCount(query ? visibleTotal : null);
    if (!query) isLibraryFiltering = false;
  }

  function clearLibrarySearch() {
    dom.librarySearch.value = '';
    dom.librarySearchClear.hidden = true;
    isLibraryFiltering = false;
    applyLibraryFilter('');
    dom.librarySearch.focus();
  }

  function onLibrarySearchInput() {
    applyLibraryFilter(dom.librarySearch.value);
    dom.librarySearchClear.hidden = !dom.librarySearch.value;
  }

  function onLibrarySummaryClick(event) {
    const summary = event.target.closest('.component-group-summary');
    if (!summary || isLibraryFiltering) return;
    const group = summary.parentElement;
    const categoryId = group?.dataset.category;
    if (!categoryId) return;
    // click fires before <details> flips open
    if (group.open) libraryOpenState.delete(categoryId);
    else libraryOpenState.add(categoryId);
  }

  function buildRailMarkup(rail, railIndex, overflow, isDropTarget = false) {
    const railY = railPlateY(railIndex);
    const moduleY = railModuleY(railIndex);
    const channelTop = moduleY - 6;
    const channelBottom = moduleY + MODULE_HEIGHT + 8;
    const channelX = 60;
    const capacity = rail.capacity;
    const width = railWidth(capacity);
    const right = RAIL.x + width;
    const scaleRight = railModuleRight(capacity);
    const channelWidth = width - 20;
    const scaleY = railY + RAIL.height + 12;
    const slotLines = [];
    const scaleTicks = [];
    const scaleLabels = [];

    for (let index = 0; index <= capacity; index += 1) {
      const x = RAIL.moduleX + index * MODULE_UNIT;
      slotLines.push(
        `<line class="rail-slot-line" x1="${x}" y1="${moduleY}" x2="${x}" y2="${moduleY + MODULE_HEIGHT}"/>`
      );
      scaleTicks.push(
        `<line class="rail-scale-tick" x1="${x}" y1="${scaleY - 5}" x2="${x}" y2="${scaleY + 5}"/>`
      );
    }

    for (let index = 1; index <= capacity; index += 1) {
      const center = RAIL.moduleX + (index - 0.5) * MODULE_UNIT;
      scaleLabels.push(
        `<text class="rail-scale-label" x="${center}" y="${scaleY + 20}">${index}P</text>`
      );
    }

    const screwMarkup = (x, y) => `
      <g class="rail-screw" transform="translate(${x} ${y})">
        <circle class="rail-screw-head" r="7.2"/>
        <circle class="rail-screw-inner" r="3.2"/>
        <path class="rail-screw-cross" d="M -3.4 0 H 3.4 M 0 -3.4 V 3.4" transform="rotate(18)"/>
      </g>`;

    // Единый блок управления длиной рейки: [-] N [+].
    // Обе кнопки и текущая вместимость собраны вместе и стоят слева от
    // начала шкалы — левее первого посадочного места (RAIL.moduleX).
    // Координаты блока фиксированы относительно левого края рейки и НЕ
    // зависят от capacity: при изменении длины шкала расширяется вправо,
    // а кнопки остаются на месте и не перекрывают первый модуль, даже
    // когда рейка пуста. Увеличенная зона захвата (r=16) помогает нажимать
    // на кнопки и при уменьшении масштаба — блок масштабируется вместе
    // с рейкой, поэтому не «съезжает» относительно неё.
    const controlY = scaleY + 4;
    const controlLeft = 2;
    const controlWidth = 70;
    const controlHeight = 26;
    const minusX = controlLeft + 14;
    const plusX = controlLeft + controlWidth - 14;
    const valueX = controlLeft + controlWidth / 2;

    const capacityButton = (action, x, label, disabled) => `
      <g class="rail-cap-btn rail-cap-btn--${action}${disabled ? ' is-disabled' : ''}"
         data-rail-capacity="${action}" data-rail-id="${escapeHtml(rail.id)}"
         transform="translate(${x} ${controlY})" tabindex="0" role="button"
         aria-label="${escapeHtml(label)}"${disabled ? ' aria-disabled="true"' : ''}>
        <circle class="rail-cap-hit" r="16"/>
        <rect class="rail-cap-bg" x="-10" y="-10" width="20" height="20" rx="6"/>
        <path class="rail-cap-icon" d="M -4 0 H 4${action === 'increase' ? ' M 0 -4 V 4' : ''}"/>
      </g>`;
    const capacityControls = `
      <g class="rail-cap-control" aria-label="${escapeHtml(`Длина рейки ${railIndex + 1}`)}">
        <rect class="rail-cap-control-bg" x="${controlLeft}" y="${controlY - controlHeight / 2}"
              width="${controlWidth}" height="${controlHeight}" rx="${controlHeight / 2}"/>
        <text class="rail-cap-control-value" x="${valueX}" y="${controlY + 3.4}">${capacity}P</text>
        ${capacityButton('decrease', minusX, `Укоротить рейку ${railIndex + 1}`, capacity <= MIN_RAIL_CAPACITY)}
        ${capacityButton('increase', plusX, `Удлинить рейку ${railIndex + 1}`, capacity >= MAX_RAIL_CAPACITY)}
      </g>`;

    const canDelete = rail.modules.length === 0 && project.rails.length > 1;
    const deleteButton = canDelete ? `
      <g class="rail-delete" data-delete-rail="${escapeHtml(rail.id)}"
         transform="translate(${right - 62} ${railY + 26})"
         tabindex="0" role="button" aria-label="${escapeHtml(`Удалить пустую рейку ${railIndex + 1}`)}">
        <circle class="rail-delete-hit" r="15"/>
        <circle class="rail-delete-bg" r="10"/>
        <path class="rail-delete-x" d="M -3.2 -3.2 L 3.2 3.2 M 3.2 -3.2 L -3.2 3.2"/>
      </g>` : '';

    return `
      <g class="rail${isDropTarget ? (overflow ? ' is-overflow' : ' is-drop-target') : ''}"
         data-rail-id="${escapeHtml(rail.id)}" data-rail-index="${railIndex}">
        <text class="rail-label" x="${RAIL.x + 4}" y="${railY - 9}">Рейка ${railIndex + 1} · ${capacity} P</text>
        <rect class="rail-plate" x="${RAIL.x}" y="${railY}" width="${width}" height="${RAIL.height}"
              rx="18" filter="url(#rail-shadow)"/>
        <line class="rail-profile-highlight" x1="${RAIL.x + 19}" y1="${railY + 1.5}"
              x2="${right - 19}" y2="${railY + 1.5}"/>
        <line class="rail-profile-shadow" x1="${RAIL.x + 19}" y1="${railY + RAIL.height - 1.5}"
              x2="${right - 19}" y2="${railY + RAIL.height - 1.5}"/>
        <line class="rail-profile-side" x1="${RAIL.x + 1.4}" y1="${railY + 20}"
              x2="${RAIL.x + 1.4}" y2="${railY + RAIL.height - 20}"/>
        <line class="rail-profile-side" x1="${right - 1.4}" y1="${railY + 20}"
              x2="${right - 1.4}" y2="${railY + RAIL.height - 20}"/>
        <line class="rail-groove" x1="${RAIL.x + 24}" y1="${railY + 18}"
              x2="${right - 24}" y2="${railY + 18}"/>
        <line class="rail-groove-light" x1="${RAIL.x + 24}" y1="${railY + 17}"
              x2="${right - 24}" y2="${railY + 17}"/>
        <line class="rail-groove" x1="${RAIL.x + 24}" y1="${railY + RAIL.height - 18}"
              x2="${right - 24}" y2="${railY + RAIL.height - 18}"/>
        <line class="rail-groove-light" x1="${RAIL.x + 24}" y1="${railY + RAIL.height - 19}"
              x2="${right - 24}" y2="${railY + RAIL.height - 19}"/>
        <rect class="rail-perforation" x="${RAIL.x}" y="${railY}" width="${width}" height="${channelTop - railY}"
              fill="url(#rail-holes)"/>
        <rect class="rail-perforation" x="${RAIL.x}" y="${channelBottom}" width="${width}"
              height="${railY + RAIL.height - channelBottom}" fill="url(#rail-holes)"/>
        <rect class="rail-channel" x="${channelX}" y="${channelTop}" width="${channelWidth}" height="${channelBottom - channelTop}" rx="7"/>
        <line class="rail-metal-edge" x1="${channelX + 5}" y1="${channelTop + 2}" x2="${channelX + channelWidth - 5}" y2="${channelTop + 2}"/>
        <line class="rail-metal-edge" x1="${channelX + 5}" y1="${channelBottom - 2}" x2="${channelX + channelWidth - 5}" y2="${channelBottom - 2}"/>
        ${slotLines.join('')}
        ${screwMarkup(62, railY + 22)}
        ${screwMarkup(right - 12, railY + 22)}
        ${screwMarkup(62, railY + RAIL.height - 22)}
        ${screwMarkup(right - 12, railY + RAIL.height - 22)}
        <text class="rail-dimension" x="${right + 18}" y="${railY + 133}" transform="rotate(90 ${right + 18} ${railY + 133})">DIN 35 mm</text>
        <g class="rail-scale">
          <line class="rail-scale-base" x1="${RAIL.moduleX}" y1="${scaleY}" x2="${scaleRight}" y2="${scaleY}"/>
          ${scaleTicks.join('')}
          ${scaleLabels.join('')}
        </g>
        ${overflow ? `<rect class="rail-overflow-outline" x="${channelX - 2}" y="${channelTop - 2}"
                            width="${channelWidth + 4}" height="${channelBottom - channelTop + 4}" rx="10"/>` : ''}
        ${capacityControls}
        ${deleteButton}
      </g>`;
  }

  function laneY(side, lane, railIndex) {
    const y = railModuleY(railIndex);
    return side === 'top'
      ? y - WIRE_OFFSET - lane * WIRE_LANE_GAP
      : y + MODULE_HEIGHT + WIRE_OFFSET + lane * WIRE_LANE_GAP;
  }

  function spansOverlap(first, second) {
    return first[0] < second[1] + WIRE_LANE_GAP && second[0] < first[1] + WIRE_LANE_GAP;
  }

  function laneKey(side, railIndex) {
    return `${side}:${railIndex}`;
  }

  // Параллельные провода получают свой «ряд» со смещением 8px.
  function reserveLane(side, railIndex, span, laneUsage) {
    const key = laneKey(side, railIndex);
    const lanes = laneUsage.rails[key] || (laneUsage.rails[key] = []);
    let lane = 0;
    while (lanes[lane]?.some((used) => spansOverlap(used, span))) lane += 1;
    if (!lanes[lane]) lanes[lane] = [];
    lanes[lane].push(span);
    return lane;
  }

  // Вертикальные участки между рейками тоже получают отдельные «ряды»,
  // чтобы провода не накладывались друг на друга в коридоре.
  function reserveCorridor(side, ySpan, laneUsage) {
    const lanes = laneUsage.corridors[side];
    let lane = 0;
    while (lanes[lane]?.some((used) => spansOverlap(used, ySpan))) lane += 1;
    if (!lanes[lane]) lanes[lane] = [];
    lanes[lane].push(ySpan);
    return lane;
  }

  function corridorX(side, lane) {
    // Правый коридор следует за правой кромкой холста: при длинной рейке
    // провода не должны идти сквозь пластину.
    const base = side === 'left'
      ? WIRE_CORRIDOR_X.left
      : Math.max(WIRE_CORRIDOR_X.right, canvasWidth() - 20);
    const shift = lane * CORRIDOR_LANE_GAP * (side === 'left' ? -1 : 1);
    return clamp(base + shift, 8, canvasWidth() - 8);
  }

  // Ряды коротких выводов боковых клемм считаются отдельно от коридоров
  // обычных проводов: иначе соседние клеммы одной шины «съедали» бы все
  // коридорные ряды и отводы получались бы слишком длинными.
  function reserveStub(side, ySpan, laneUsage) {
    const lanes = laneUsage.stubs[side] || (laneUsage.stubs[side] = []);
    let lane = 0;
    while (lanes[lane]?.some((used) => spansOverlap(used, ySpan))) lane += 1;
    if (!lanes[lane]) lanes[lane] = [];
    lanes[lane].push(ySpan);
    return lane;
  }

  // Боковая клемма шины выходит горизонтально из модуля на небольшое
  // расстояние, после чего провод продолжается ортогональным маршрутом
  // по ряду над/под модулями — без длинной линии поперёк корпусов.
  function sidePortAnchor(port, laneUsage, reserve, ySpan) {
    const span = ySpan || [port.y - 1, port.y + 1];
    const lane = reserve ? reserveStub(port.side, span, laneUsage) : 0;
    const offset = WIRE_STUB + lane * CORRIDOR_LANE_GAP;
    return {
      x: port.x + (port.side === 'left' ? -offset : offset),
      y: port.y
    };
  }

  // Ряды для проводов, идущих от источника питания вниз к модулям.
  function reserveSourceLane(span, laneUsage) {
    const lanes = laneUsage.source || (laneUsage.source = []);
    let lane = 0;
    while (lanes[lane]?.some((used) => spansOverlap(used, span))) lane += 1;
    if (!lanes[lane]) lanes[lane] = [];
    lanes[lane].push(span);
    return lane;
  }

  function sourceLaneY(lane) {
    return POWER_SOURCE.y + POWER_SOURCE.height + 16 + lane * WIRE_LANE_GAP;
  }

  function pickWireBadge(points) {
    // Бейдж ставим на середину самой длинной горизонтальной строки.
    let badge = null;
    for (let index = 0; index < points.length - 1; index += 1) {
      const [first, second] = [points[index], points[index + 1]];
      if (first[1] !== second[1]) continue;
      const length = Math.abs(second[0] - first[0]);
      if (!badge || length > badge.length) {
        badge = { length, x: (first[0] + second[0]) / 2, y: first[1] };
      }
    }
    if (!badge) {
      const first = points[0];
      const last = points[points.length - 1];
      badge = { x: (first[0] + last[0]) / 2, y: (first[1] + last[1]) / 2 };
    }
    return badge;
  }

  // Провода от источника питания: вниз от порта, поворот и вход в порт
  // модуля. Для верхнего порта первой рейки — короткий маршрут вниз;
  // в остальных случаях обходим корпуса по боковому коридору.
  function buildSourceWireLayout(connection, start, end, laneUsage, reserve) {
    const startIsSource = start.moduleId === POWER_SOURCE.id;
    const endIsSource = end.moduleId === POWER_SOURCE.id;
    if (startIsSource === endIsSource) return null;

    const source = startIsSource ? start : end;
    const target = startIsSource ? end : start;
    const span = [Math.min(source.x, target.x), Math.max(source.x, target.x)];
    const sourceLane = reserve ? reserveSourceLane(span, laneUsage) : 0;
    const ySource = sourceLaneY(sourceLane);

    if (target.railIndex === 0 && target.side === 'top') {
      const points = [
        [source.x, source.y],
        [source.x, ySource],
        [target.x, ySource],
        [target.x, target.y]
      ];
      return { connection, points, badge: pickWireBadge(points) };
    }

    // Боковая клемма шины: вниз от источника, по ряду над модулями к
    // короткому отводу клеммы, затем горизонтально прямо в неё.
    // Все сегменты ортогональны.
    if (isSidePort(target.side)) {
      const anchor = sidePortAnchor(
        target, laneUsage, reserve,
        [Math.min(ySource, target.y), Math.max(ySource, target.y)]
      );
      const points = [
        [source.x, source.y],
        [source.x, ySource],
        [anchor.x, ySource],
        [anchor.x, target.y],
        [target.x, target.y]
      ];
      return { connection, points, badge: pickWireBadge(points) };
    }

    const targetLane = reserve ? reserveLane(target.side, target.railIndex, span, laneUsage) : 0;
    const yTarget = laneY(target.side, targetLane, target.railIndex);
    const railCenter = railModuleCenter(target.railIndex);
    const side = target.x < railCenter ? 'left' : 'right';
    const corridorLane = reserve
      ? reserveCorridor(side, [Math.min(ySource, yTarget), Math.max(ySource, yTarget)], laneUsage)
      : 0;
    const corridor = corridorX(side, corridorLane);

    const points = [
      [source.x, source.y],
      [source.x, ySource],
      [corridor, ySource],
      [corridor, yTarget],
      [target.x, yTarget],
      [target.x, target.y]
    ];
    return { connection, points, badge: pickWireBadge(points) };
  }

  // Маршрут с участием боковых клемм шин. Порт сначала выходит коротким
  // отводом из корпуса, затем провод идёт по ряду над модулями — все
  // изломы остаются строго ортогональными.
  function buildSideWireLayout(connection, start, end, laneUsage, reserve, span) {
    const startIsSide = isSidePort(start.side);
    const endIsSide = isSidePort(end.side);
    const transferY = Math.min(
      laneY('top', 0, start.railIndex),
      laneY('top', 0, end.railIndex)
    );
    const ySpan = [
      Math.min(start.y, end.y, transferY),
      Math.max(start.y, end.y, transferY)
    ];

    if (startIsSide && endIsSide) {
      const a = sidePortAnchor(start, laneUsage, reserve, ySpan);
      const b = sidePortAnchor(end, laneUsage, reserve, ySpan);
      const points = [
        [start.x, start.y], [a.x, start.y],
        [a.x, transferY], [b.x, transferY],
        [b.x, end.y], [end.x, end.y]
      ];
      return { connection, points, badge: pickWireBadge(points) };
    }

    if (startIsSide) {
      const a = sidePortAnchor(start, laneUsage, reserve, ySpan);
      const endLane = reserve ? reserveLane(end.side, end.railIndex, span, laneUsage) : 0;
      const y2 = laneY(end.side, endLane, end.railIndex);
      const points = [
        [start.x, start.y], [a.x, start.y],
        [a.x, y2], [end.x, y2], [end.x, end.y]
      ];
      return { connection, points, badge: pickWireBadge(points) };
    }

    const b = sidePortAnchor(end, laneUsage, reserve, ySpan);
    const startLane = reserve ? reserveLane(start.side, start.railIndex, span, laneUsage) : 0;
    const y1 = laneY(start.side, startLane, start.railIndex);
    const points = [
      [start.x, start.y], [start.x, y1],
      [b.x, y1], [b.x, end.y], [end.x, end.y]
    ];
    return { connection, points, badge: pickWireBadge(points) };
  }

  function buildWireLayout(connection, positions, laneUsage, reserve = true) {
    const start = getPortPoint(connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex, positions);
    const end = getPortPoint(connection.toModuleId, connection.toPortSide, connection.toPortIndex, positions);
    if (!start || !end) return null;

    if (start.moduleId === POWER_SOURCE.id || end.moduleId === POWER_SOURCE.id) {
      return buildSourceWireLayout(connection, start, end, laneUsage, reserve);
    }

    const sameRail = Boolean(start.railId) && start.railId === end.railId;
    const span = [Math.min(start.x, end.x), Math.max(start.x, end.x)];
    if (isSidePort(start.side) || isSidePort(end.side)) {
      return buildSideWireLayout(connection, start, end, laneUsage, reserve, span);
    }
    const startLane = reserve ? reserveLane(start.side, start.railIndex, span, laneUsage) : 0;
    const endLane = start.side === end.side
      ? startLane
      : (reserve ? reserveLane(end.side, end.railIndex, span, laneUsage) : 0);
    const y1 = laneY(start.side, startLane, start.railIndex);
    const y2 = laneY(end.side, endLane, end.railIndex);

    let points;
    if (sameRail && start.side === end.side) {
      // Одна грань одной рейки: вверх/вниз от порта, горизонтально, затем к порту.
      points = [
        [start.x, start.y], [start.x, y1],
        [end.x, y1], [end.x, end.y]
      ];
    } else {
      // Разные грани или разные рейки: обходим корпуса сбоку. Вертикальный
      // участок идёт по коридору вне пластины рейки, поэтому провода не
      // накладываются на рейки.
      const railCenter = railModuleCenter(start.railIndex);
      const useLeft = (start.x + end.x) / 2 < railCenter;
      const side = useLeft ? 'left' : 'right';
      const corridorLane = reserve
        ? reserveCorridor(side, [Math.min(y1, y2), Math.max(y1, y2)], laneUsage)
        : 0;
      const x = corridorX(side, corridorLane);
      points = [
        [start.x, start.y], [start.x, y1],
        [x, y1], [x, y2],
        [end.x, y2], [end.x, end.y]
      ];
    }

    return { connection, points, badge: pickWireBadge(points) };
  }

  function buildWireLayouts(positions) {
    const laneUsage = {
      rails: {},
      corridors: { left: [], right: [] },
      stubs: { left: [], right: [] },
      source: []
    };
    const layouts = [];
    for (const connection of project.connections) {
      const layout = buildWireLayout(connection, positions, laneUsage);
      if (layout) layouts.push(layout);
    }
    // Выделенный провод рисуется последним, чтобы его хало и кнопка были сверху.
    layouts.sort((left, right) =>
      Number(left.connection.id === selectedConnectionId) -
      Number(right.connection.id === selectedConnectionId)
    );
    return layouts;
  }

  function polylinePoints(points) {
    return points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  }

  // Возвращает две независимые части разметки, чтобы каждая попала в свою
  // группу <g>: polyline-хало/линии → #layer-wires, подписи → #layer-labels.
  // Обёртка подписи наследует классы провода, поэтому CSS-правила вида
  // `.wire--l2 .wire-badge rect` продолжают работать в слое подписей.
  function buildWiresMarkup(layouts) {
    const wires = [];
    const labels = [];

    for (const layout of layouts) {
      const connection = layout.connection;
      const typeKey = WIRE_TYPES[connection.type] ? connection.type : DEFAULT_WIRE_TYPE;
      const type = WIRE_TYPES[typeKey];
      const color = wireDisplayColor(typeKey);
      const isSelected = connection.id === selectedConnectionId;
      const flowClass = isSimulationOn()
        ? (connection.isLive ? ' is-live' : ' is-dead')
        : '';
      const wireClass = `wire wire--${typeKey.toLowerCase()}${isSelected ? ' is-selected selected' : ''}${flowClass}`;
      const wireStyle = `--wire-color:${color};color:${color}`;
      const label = connectionLabel(connection);
      const points = polylinePoints(layout.points);
      const badgeWidth = type.label.length > 1 ? 24 : 16;
      const customLabelText = typeof connection.label === 'string' ? connection.label.trim() : '';
      const effectiveBadgeWidth = customLabelText ? wireLabelWidth(customLabelText) : badgeWidth;
      const badgeX = layout.badge.x;
      const badgeY = layout.badge.y;
      // Режим параметров: по центру провода — плашка с силой тока.
      const showParams = isShowingParams() && isSimulationOn() && connection.isLive;
      const labelY = badgeY + (showParams ? -17 : 0);
      // У чёрного L2 на тёмном холсте нужен светлый контур, иначе линия теряется.
      const outline = typeKey === 'L2'
        ? `<polyline class="wire-outline" points="${points}"/>`
        : '';
      const customLabel = wireLabelMarkup(connection, badgeX, labelY);
      const typeBadge = customLabel ? '' : `
          <g class="wire-badge" transform="translate(${badgeX.toFixed(1)} ${labelY.toFixed(1)})" pointer-events="none">
            <rect x="${-badgeWidth / 2}" y="-9" width="${badgeWidth}" height="18" rx="9" fill="${color}"/>
            <text class="${tagTextClass(color)}" x="0" y="3.4">${type.label}</text>
          </g>`;
      const currentBadge = showParams ? `
          <g class="wire-current-badge${connection.overloaded ? ' is-overloaded' : ''}"
             transform="translate(${badgeX.toFixed(1)} ${badgeY.toFixed(1)})" pointer-events="none">
            <rect class="wire-current-bg" x="-22" y="-9" width="44" height="18" rx="7"/>
            <text class="wire-current-text" x="0" y="4">${escapeHtml(formatCurrent(connection.current))}</text>
          </g>` : '';
      const deleteButton = isSelected ? `
        <g class="wire-delete" data-delete-wire="${escapeHtml(connection.id)}"
           transform="translate(${(badgeX + effectiveBadgeWidth / 2 + 10).toFixed(1)} ${badgeY.toFixed(1)})"
           tabindex="0" role="button"
           aria-label="${escapeHtml(`Удалить провод ${label}`)}">
          <circle class="wire-delete-hit" r="13"/>
          <circle class="wire-delete-bg" r="9"/>
          <path class="wire-delete-x" d="M -3 -3 L 3 3 M 3 -3 L -3 3"/>
        </g>` : '';

      wires.push(`
        <g class="${wireClass}"
           data-wire-id="${escapeHtml(connection.id)}"
           style="${wireStyle}">
          <title>${escapeHtml(`${label}. ${type.name}. ${connection.isLive ? 'Под напряжением. ' : ''}${showParams ? `Напряжение ${connection.voltage} В, ток ${formatCurrent(connection.current)}. ` : ''}Двойной клик — маркировка провода.`)}</title>
          <polyline class="wire-halo" points="${points}" data-connection-id="${escapeHtml(connection.id)}"
                    tabindex="0" role="button"
                    aria-label="${escapeHtml(`${label}, ${type.name}. Enter — выделить, Delete — удалить, двойной клик — маркировка.`)}"/>
          ${outline}
          <polyline class="wire-path" points="${points}"/>
          ${deleteButton}
        </g>`);

      const labelMarkup = customLabel + typeBadge + currentBadge;
      if (labelMarkup) {
        labels.push(`
        <g class="label-node ${wireClass}" style="${wireStyle}">
          ${labelMarkup}
        </g>`);
      }
    }

    return { wires: wires.join(''), labels: labels.join('') };
  }

  function buildPreviewWire(positions) {
    if (!activePort || !pendingWire) return '';
    const draft = {
      fromModuleId: activePort.moduleId,
      fromPortSide: activePort.side,
      fromPortIndex: activePort.index,
      toModuleId: pendingWire.moduleId,
      toPortSide: pendingWire.side,
      toPortIndex: pendingWire.index
    };
    const laneUsage = {
      rails: {},
      corridors: { left: [], right: [] },
      stubs: { left: [], right: [] },
      source: []
    };
    const layout = buildWireLayout(draft, positions, laneUsage, false);
    if (!layout) return '';
    return `<polyline class="wire-preview" points="${polylinePoints(layout.points)}"/>`;
  }

  function buildSourceMarkup(occupancy, phases) {
    const { width, height, ports } = POWER_SOURCE;
    const isOn = project?.source?.isOn !== false;
    const radius = 14;
    const switchWidth = 96;
    const switchHeight = 30;
    const switchPadding = 4;
    const leverWidth = 40;
    const leverHeight = switchHeight - switchPadding * 2;
    const leverTravel = switchWidth - leverWidth - switchPadding * 2;
    const switchX = width - switchWidth - 16;
    const switchY = 14;
    const leverX = switchX + switchPadding + (isOn ? leverTravel : 0);
    const leverY = switchY + switchPadding;
    const stripeY = leverY + leverHeight / 2;
    const switchCenterX = switchX + switchWidth / 2;

    const portMarkup = ports.map((label, index) => {
      const portX = ((index + 1) * width) / (ports.length + 1);
      return `
        <text class="power-source-port-label" x="${portX.toFixed(1)}" y="${height - 17}">${label}</text>
        <line class="power-source-port-tick" x1="${portX.toFixed(1)}" y1="${height - 11}"
              x2="${portX.toFixed(1)}" y2="${height - 3}"/>`;
    }).join('');

    return `
      <g class="power-source ${isOn ? 'is-on' : 'is-off'}" data-source-id="${POWER_SOURCE.id}"
         transform="translate(${POWER_SOURCE.x} ${POWER_SOURCE.y})">
        <title>${escapeHtml(`Источник питания. Главный рубильник ${isOn ? 'включён' : 'выключен'}.`)}</title>
        <rect class="power-source-shadow" x="1" y="4" width="${width}" height="${height}" rx="${radius}"/>
        <rect class="power-source-body" x="0" y="0" width="${width}" height="${height}" rx="${radius}"/>
        <path class="power-source-band"
              d="M 0 ${radius} Q 0 0 ${radius} 0 H ${width - radius} Q ${width} 0 ${width} ${radius} V 30 H 0 Z"/>
        <text class="power-source-title" x="18" y="21">${escapeHtml(POWER_SOURCE.label)}</text>
        <text class="power-source-caption" x="18" y="39">${escapeHtml(POWER_SOURCE.caption)}</text>
        <circle class="power-source-led" cx="22" cy="56" r="4"/>
        <text class="power-source-state" x="33" y="59">${isOn ? 'НАПРЯЖЕНИЕ ЕСТЬ' : 'НАПРЯЖЕНИЕ СНЯТО'}</text>
        <rect class="power-source-panel" x="${switchX - 6}" y="${switchY - 6}"
              width="${switchWidth + 12}" height="${switchHeight + 12}" rx="10"/>
        <g class="power-source-switch" data-state="${isOn ? 'on' : 'off'}" data-toggle-source="true"
           tabindex="0" role="switch" aria-checked="${isOn}"
           aria-label="${escapeHtml(`Главный рубильник источника питания: ${isOn ? 'включён' : 'выключен'}`)}">
          <title>${escapeHtml(`Главный рубильник: ${isOn ? 'ВКЛ' : 'ОТКЛ'}`)}</title>
          <rect class="power-source-switch-hit" x="${switchX}" y="${switchY}"
                width="${switchWidth}" height="${switchHeight}" rx="8"/>
          <rect class="power-source-switch-track" x="${switchX}" y="${switchY}"
                width="${switchWidth}" height="${switchHeight}" rx="8"/>
          <rect class="power-source-switch-lever" x="${leverX}" y="${leverY}"
                width="${leverWidth}" height="${leverHeight}" rx="6"/>
          <line class="power-source-switch-stripe" x1="${leverX + 10}" y1="${stripeY}"
                x2="${leverX + leverWidth - 10}" y2="${stripeY}"/>
        </g>
        <text class="power-source-switch-label" x="${switchCenterX}" y="${switchY + switchHeight + 13}">${isOn ? 'ВКЛ' : 'ОТКЛ'}</text>
        ${portMarkup}
        ${buildSourcePortsMarkup(occupancy, phases)}
      </g>`;
  }

  // Пульсация активного порта анимирует только радиус и прозрачность самого
  // <circle>. SMIL работает в системе координат окружности, поэтому свечение
  // остаётся привязанным к cx/cy порта и не улетает в левый верхний угол (0,0).
  function portPulseMarkup(radius) {
    return `<animate attributeName="r" values="${(radius + 1).toFixed(1)};${(radius + 10).toFixed(1)}" dur="1.15s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="0.95;0" dur="1.15s" repeatCount="indefinite"/>`;
  }

  // Порты источника рендерятся внутри его группы (локальные cx/cy) в
  // #layer-power-source. Группа всегда видна, поэтому порты доступны для
  // подключения проводов даже при выключенном слое «Модули».
  function buildSourcePortsMarkup(occupancy, phases) {
    const regular = [];
    let activeMarkup = '';
    const phaseMap = phases || new Map();

    POWER_SOURCE.ports.forEach((label, index) => {
      const point = localSourcePortPoint(index);
      const portId = makePortId(POWER_SOURCE.id, 'bottom', index);
      const portRef = { moduleId: POWER_SOURCE.id, side: 'bottom', index };
      const isActive = samePort(activePort, portRef);
      const isPending = samePort(pendingWire, portRef);
      const phase = phaseMap.get(portId) || null;
      const phaseName = phase ? WIRE_TYPES[phase].name : '';
      const classes = [
        'port',
        'source-port',
        isActive ? 'is-active' : '',
        isPending ? 'is-pending' : '',
        occupancy.has(portId) ? 'is-connected' : '',
        phase ? 'has-phase' : ''
      ].filter(Boolean).join(' ');
      const hint = isActive ? 'Выберите второй порт' : 'Нажмите, чтобы начать провод';
      const phaseHint = phase ? ` Фаза ${phase} (${phaseName}).` : '';
      const phaseAttrs = phase
        ? `data-phase="${phase}" data-phase-label="Источник · ${escapeHtml(label)}" style="--port-phase-color:${wireDisplayColor(phase)}"`
        : '';
      const pulse = isActive ? portPulseMarkup(PORT_RADIUS) : '';
      const markup = `
        <g class="${classes}" id="${portId}" data-port-id="${portId}" data-module-id="${POWER_SOURCE.id}"
           data-side="bottom" data-index="${index}" data-hit-radius="${PORT_HIT_RADIUS}"
            tabindex="0" role="button"
           ${phaseAttrs}
           aria-label="${escapeHtml(`Источник питания · ${label}.${phaseHint} ${hint}`)}">
          <circle class="port-hit" cx="${point.x.toFixed(1)}" cy="${point.y}" r="${PORT_HIT_RADIUS}"/>
          <circle class="port-halo" cx="${point.x.toFixed(1)}" cy="${point.y}" r="8">${pulse}</circle>
          <circle class="port-dot" cx="${point.x.toFixed(1)}" cy="${point.y}" r="${PORT_RADIUS}"/>
        </g>`;
      if (isActive) activeMarkup = markup;
      else regular.push(markup);
    });

    return regular.join('') + activeMarkup;
  }

  // Порты конкретного модуля. Возвращают разметку в ЛОКАЛЬНЫХ координатах
  // корпуса: она вставляется прямо внутрь <g class="module"> перед </g>.
  // Благодаря этому порты, хало и SMIL-пульсация всегда живут в слое
  // модулей, имеют корректные cx/cy и не превращаются в артефакт у (0,0).
  function buildModulePortsMarkup(module, width, occupancy, phases) {
    if (module.__ghost) return '';
    const regular = [];
    let activeMarkup = '';
    const phaseMap = phases || new Map();
    const counts = portsForModule(module);
    const busType = isBusbarModule(module) ? busbarTypeOf(module) : null;
    const busLive = Boolean(busType) && isSimulationOn() && moduleHasLivePort(module, livePorts);

    for (const side of PORT_SIDES) {
      for (let index = 0; index < counts[side]; index += 1) {
        const point = localModulePortPoint(width, side, index, counts);
        const x = point.x;
        const y = point.y;
        const dotRadius = isSidePort(side) ? SIDE_PORT_RADIUS : PORT_RADIUS;
        const hitRadius = isSidePort(side) ? SIDE_PORT_HIT_RADIUS : PORT_HIT_RADIUS;
        const portId = makePortId(module.id, side, index);
        const portRef = { moduleId: module.id, side, index };
        const isActive = samePort(activePort, portRef);
        const isPending = samePort(pendingWire, portRef);
        const phase = phaseMap.get(portId) || null;
        const phaseName = phase ? WIRE_TYPES[phase].name : '';
        const classes = [
          'port',
          isSidePort(side) ? 'port--side' : '',
          isActive ? 'is-active' : '',
          isPending ? 'is-pending' : '',
          occupancy.has(portId) ? 'is-connected' : '',
          phase ? 'has-phase' : '',
          busLive ? 'is-bus-live' : '',
          busLive && busType ? `bus-live-${busType.toLowerCase()}` : ''
        ].filter(Boolean).join(' ');
        const hint = isActive ? 'Выберите второй порт' : 'Нажмите, чтобы начать провод';
        const phaseHint = phase ? ` Фаза ${phase} (${phaseName}).` : '';
        const phaseAttrs = phase
          ? `data-phase="${phase}" data-phase-label="${escapeHtml(formatPortLabel(module, side, index))}" style="--port-phase-color:${wireDisplayColor(phase)}"`
          : '';
        const pulse = isActive ? portPulseMarkup(dotRadius) : '';
        const markup = `
          <g class="${classes}" id="${portId}" data-port-id="${portId}" data-module-id="${escapeHtml(module.id)}"
             data-side="${side}" data-index="${index}" data-hit-radius="${hitRadius}"
             tabindex="0" role="button"
             ${phaseAttrs}
             aria-label="${escapeHtml(`${formatPortLabel(module, side, index)}.${phaseHint} ${hint}`)}">
            <circle class="port-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${hitRadius}"/>
            <circle class="port-halo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${dotRadius + 4}">${pulse}</circle>
            <circle class="port-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${dotRadius}"/>
          </g>`;
        // Активный порт рисуется последним — поверх остальных портов модуля.
        if (isActive) activeMarkup = markup;
        else regular.push(markup);
      }
    }
    return regular.join('') + activeMarkup;
  }

  function overlayAnchor(ref) {
    if (!ref) return null;
    const portId = makePortId(ref.moduleId, ref.side, ref.index);
    const element = dom.canvas.querySelector(`[data-port-id="${portId}"] .port-dot`);
    return element ? element.getBoundingClientRect() : null;
  }

  function placeOverlay(element, anchorRect, gap) {
    if (!element || !anchorRect) return;
    const wrapRect = dom.svgWrap.getBoundingClientRect();
    const width = element.offsetWidth || 160;
    const height = element.offsetHeight || 34;
    let left = anchorRect.left - wrapRect.left + anchorRect.width / 2 - width / 2;
    let top = anchorRect.top - wrapRect.top - height - gap;
    if (top < 6) top = anchorRect.bottom - wrapRect.top + gap;
    element.style.left = `${clamp(left, 6, Math.max(6, wrapRect.width - width - 6))}px`;
    element.style.top = `${clamp(top, 6, Math.max(6, wrapRect.height - height - 6))}px`;
  }

  function positionOverlays() {
    const tooltipRect = overlayAnchor(activePort);
    if (dom.portTooltip) {
      dom.portTooltip.hidden = !activePort;
      if (activePort) {
        dom.portTooltip.textContent = pendingWire ? 'Выберите тип провода' : 'Выберите второй порт';
        placeOverlay(dom.portTooltip, tooltipRect, 12);
      }
    }
    if (dom.wireTypePopover) {
      dom.wireTypePopover.hidden = !pendingWire;
      if (pendingWire) placeOverlay(dom.wireTypePopover, overlayAnchor(pendingWire), 14);
    }
  }

  // Тултип с названием фазы при наведении на занятый/унаследованный порт.
  function onPortPointerOver(event) {
    const port = event.target.closest?.('[data-port-id][data-phase]');
    if (!port || !dom.portPhaseTooltip) return;
    const phase = port.dataset.phase;
    const type = WIRE_TYPES[phase];
    if (!type) return;

    const label = port.dataset.phaseLabel || portRefLabel({
      moduleId: port.dataset.moduleId,
      side: port.dataset.side,
      index: Number(port.dataset.index)
    });
    dom.portPhaseTooltip.innerHTML = `
      <i class="port-phase-dot" style="--port-phase-color:${wireDisplayColor(phase)}" aria-hidden="true"></i>
      <span>${escapeHtml(label)} <strong>(${escapeHtml(phase)})</strong></span>
      <small>${escapeHtml(type.name)}</small>`;
    dom.portPhaseTooltip.hidden = false;

    const dot = port.querySelector('.port-dot');
    const rect = dot ? dot.getBoundingClientRect() : port.getBoundingClientRect();
    placeOverlay(dom.portPhaseTooltip, rect, 10);
  }

  function onPortPointerOut(event) {
    const port = event.target.closest?.('[data-port-id][data-phase]');
    if (!port || !dom.portPhaseTooltip) return;
    if (port.contains(event.relatedTarget)) return;
    dom.portPhaseTooltip.hidden = true;
  }

  /* Подсказка с параметрами сети при наведении на модуль или провод. */
  function hideElementTooltip() {
    if (dom.elementTooltip) dom.elementTooltip.hidden = true;
  }

  function elementParams(target) {
    const wireEl = target.closest?.('[data-wire-id]');
    if (wireEl) {
      const connection = project.connections.find(
        (item) => item.id === wireEl.getAttribute('data-wire-id')
      );
      if (!connection) return null;
      const voltage = Number(connection.voltage) || 0;
      const current = Number(connection.current) || 0;
      return {
        title: connectionLabel(connection),
        subtitle: `${connection.type} · ${connection.isLive ? 'под напряжением' : 'обесточен'}`,
        voltage,
        current,
        power: voltage * current,
        overloaded: Boolean(connection.overloaded)
      };
    }

    const moduleEl = target.closest?.('[data-module-id]');
    if (!moduleEl) return null;
    const moduleId = moduleEl.getAttribute('data-module-id');
    if (moduleId === POWER_SOURCE.id) {
      return {
        title: POWER_SOURCE.label,
        subtitle: 'ввод 3Ф + N + PE',
        voltage: project?.source?.isOn !== false ? NOMINAL_VOLTAGE : 0,
        current: 0,
        power: 0,
        overloaded: false
      };
    }
    const module = moduleById(moduleId);
    if (!module) return null;
    const voltage = isSimulationOn() && moduleHasLivePort(module, livePorts) ? NOMINAL_VOLTAGE : 0;
    const current = Number(module.current) || 0;
    const load = isLoadModule(module);
    return {
      title: `${module.tag} · ${module.name}`,
      subtitle: load ? `нагрузка ${formatPower(module.power)}` : typeLabelFor(module),
      voltage,
      current,
      power: load ? normalizeLoadPower(module.power, DEFAULT_LOAD_POWER) : voltage * current,
      overloaded: isModuleOverloaded(module)
    };
  }

  function onElementPointerOver(event) {
    if (!dom.elementTooltip || editing) {
      hideElementTooltip();
      return;
    }
    // У клемм есть собственная подсказка с фазой — не перекрываем её.
    if (event.target.closest?.('[data-port-id]')) {
      hideElementTooltip();
      return;
    }
    const params = elementParams(event.target);
    if (!params) {
      hideElementTooltip();
      return;
    }
    dom.elementTooltip.innerHTML = `
      <strong>${escapeHtml(params.title)}</strong>
      <small>${escapeHtml(params.subtitle)}</small>
      <span class="element-tooltip-grid">
        <span>Напряжение</span><b>${Math.round(params.voltage)} В</b>
        <span>Ток</span><b>${escapeHtml(formatCurrent(params.current))}</b>
        <span>Мощность</span><b>${escapeHtml(formatPower(params.power))}</b>
      </span>
      ${params.overloaded ? '<span class="element-tooltip-warning">⚠️ Перегрузка</span>' : ''}`;
    dom.elementTooltip.hidden = false;

    const wrapRect = dom.svgWrap.getBoundingClientRect();
    const width = dom.elementTooltip.offsetWidth || 190;
    const height = dom.elementTooltip.offsetHeight || 90;
    const left = clamp(event.clientX - wrapRect.left + 14, 6, Math.max(6, wrapRect.width - width - 6));
    const top = clamp(event.clientY - wrapRect.top - height - 12, 6, Math.max(6, wrapRect.height - height - 6));
    dom.elementTooltip.style.left = `${left}px`;
    dom.elementTooltip.style.top = `${top}px`;
  }

  function onElementPointerOut(event) {
    const next = event.relatedTarget;
    if (next && (next.closest?.('[data-module-id]') || next.closest?.('[data-wire-id]'))) return;
    hideElementTooltip();
  }

  // Шина — не обычный корпус автомата, а металлическая полоса с рядом
  // винтов-клемм сверху и снизу. Отрисовывается отдельно от стандартных
  // модулей, но сохраняет те же data-атрибуты, удаление и фокус.
  function buildBusbarModuleMarkup(module, x, y, options = {}) {
    const { isGhost = false, isInvalidGhost = false, isPending = false, portsMarkup = '' } = options;
    const width = module.width * MODULE_UNIT;
    const color = safeColor(module.color) || '#64748b';
    const busType = busbarTypeOf(module) || 'N';
    const typeClass = busType.toLowerCase();
    const isLive = !isGhost && isSimulationOn() && moduleHasLivePort(module, livePorts);
    const label = busType === 'PE' ? 'Шина PE' : 'Шина N';
    const sublabel = busType === 'PE'
      ? 'земля · защитный проводник'
      : 'ноль · рабочий проводник';
    const screwCount = clamp(module.width, 1, 8);
    const modulesWord = plural(module.width, ['модуль', 'модуля', 'модулей']);

    const screwMarkup = VERTICAL_PORT_SIDES.map((side) => {
      const cy = side === 'top' ? 17 : MODULE_HEIGHT - 17;
      return Array.from({ length: screwCount }, (_, index) => {
        const cx = ((index + 1) * width) / (screwCount + 1);
        return `
          <g class="busbar-screw" transform="translate(${cx.toFixed(1)} ${cy})">
            <circle class="busbar-screw-ring" r="6.6"/>
            <circle class="busbar-screw-head" r="5"/>
            <path class="busbar-screw-cross" d="M -2.7 0 H 2.7 M 0 -2.7 V 2.7"/>
          </g>`;
      }).join('');
    }).join('');

    const deleteButton = isGhost ? '' : `
      <g class="module-delete" data-delete-module="${escapeHtml(module.id)}"
         transform="translate(${width - 11} ${MODULE_HEIGHT - 12})" tabindex="0" role="button"
         aria-label="${escapeHtml(`Удалить модуль ${module.tag}`)}">
        <circle class="module-delete-hit" r="14"/>
        <circle class="module-delete-bg" r="8.5"/>
        <path class="module-delete-x" d="M -2.7 -2.7 L 2.7 2.7 M 2.7 -2.7 L -2.7 2.7"/>
      </g>`;

    const pendingBadge = isPending
      ? `<g class="module-pending-badge" transform="translate(3 -12)">
           <circle cx="8" cy="8" r="8"/>
           <text x="8" y="11.1">A</text>
         </g>`
      : '';

    const interactiveAttributes = isGhost
      ? 'aria-hidden="true"'
      : `tabindex="0" role="group"
         aria-label="${escapeHtml(`${module.tag}: ${module.name}, ширина ${module.width} ${modulesWord}. Шина ${busType} с ${screwCount} клеммами сверху и снизу. Перетаскивание меняет слот; порты создают провода только типа ${busType}.`)}"`;

    return `
      <g class="module module--busbar module--busbar-${typeClass}${isGhost ? ' module--ghost' : ''}${isInvalidGhost ? ' module--ghost-invalid' : ''}${isPending ? ' is-pending' : ''}${isLive ? ' is-bus-live' : ''}${module.groupId ? ' is-grouped' : ''}"
         data-module-id="${escapeHtml(module.id)}" transform="translate(${x} ${y})"
         style="--module-accent:${color}" ${interactiveAttributes}>
        <title>${escapeHtml(`${module.tag} · ${module.name}`)}</title>
        <rect class="module-shadow-plate" x="1" y="3" width="${width}" height="${MODULE_HEIGHT}" rx="9"/>
        <rect class="busbar-body busbar-body--${typeClass}" x="0" y="0" width="${width}"
              height="${MODULE_HEIGHT}" rx="9" stroke="${color}"/>
        <rect class="busbar-channel" x="6" y="29" width="${width - 12}" height="${MODULE_HEIGHT - 58}" rx="6"/>
        <path class="busbar-brush" d="M 11 48 H ${width - 11} M 11 ${MODULE_HEIGHT - 48} H ${width - 11}"/>
        ${screwMarkup}
        <text class="busbar-label" x="${width / 2}" y="${MODULE_HEIGHT / 2 - 2}">${label}</text>
        <text class="busbar-sublabel" x="${width / 2}" y="${MODULE_HEIGHT / 2 + 17}">${sublabel}</text>
        <g class="busbar-tag" transform="translate(${width / 2 - 23} 31)">
          <rect x="0" y="0" width="46" height="16" rx="4"/>
          <text x="23" y="11.5">${escapeHtml(module.tag)}</text>
        </g>
        <text class="module-width" x="7" y="${MODULE_HEIGHT - 8}">${module.width}P</text>
        ${deleteButton}
        <rect class="module-focus-ring" x="-4" y="-4" width="${width + 8}" height="${MODULE_HEIGHT + 8}"
              rx="13" fill="none" stroke="${color}"/>
        ${pendingBadge}
        ${portsMarkup}
      </g>`;
  }

  // Узкая шина в корпусе 1P: синий корпус, металлическая полоса (медь для N,
  // серебро для PE) вдоль левой или правой грани и 10 мелких клемм на ней.
  // Подпись стоит по центру корпуса и не перекрывает клеммы.
  function buildSideBusbarModuleMarkup(module, x, y, options = {}) {
    const { isGhost = false, isInvalidGhost = false, isPending = false, portsMarkup = '' } = options;
    const width = module.width * MODULE_UNIT;
    const color = safeColor(module.color) || '#3b82f6';
    const busType = busbarTypeOf(module) || 'N';
    const typeClass = busType.toLowerCase();
    const counts = portsForModule(module);
    const side = counts.left > 0 ? 'left' : 'right';
    const isLive = !isGhost && isSimulationOn() && moduleHasLivePort(module, livePorts);
    const plateX = side === 'left' ? -5 : width - 5;
    const labelY = MODULE_HEIGHT / 2 + (busType === 'PE' ? 6 : 7);
    const deleteX = side === 'left' ? width - 10 : 10;
    const widthX = side === 'left' ? width - 8 : 8;
    const sideWord = side === 'left' ? 'слева' : 'справа';
    const terminalCount = counts[side];

    const deleteButton = isGhost ? '' : `
      <g class="module-delete" data-delete-module="${escapeHtml(module.id)}"
         transform="translate(${deleteX} ${MODULE_HEIGHT - 12})" tabindex="0" role="button"
         aria-label="${escapeHtml(`Удалить модуль ${module.tag}`)}">
        <circle class="module-delete-hit" r="12"/>
        <circle class="module-delete-bg" r="8"/>
        <path class="module-delete-x" d="M -2.7 -2.7 L 2.7 2.7 M 2.7 -2.7 L -2.7 2.7"/>
      </g>`;

    const pendingBadge = isPending
      ? `<g class="module-pending-badge" transform="translate(3 -12)">
           <circle cx="8" cy="8" r="8"/>
           <text x="8" y="11.1">A</text>
         </g>`
      : '';

    const interactiveAttributes = isGhost
      ? 'aria-hidden="true"'
      : `tabindex="0" role="group"
         aria-label="${escapeHtml(`${module.tag}: ${module.name}, ширина 1 модуль. Шина ${busType} с ${terminalCount} клеммами ${sideWord}. Перетаскивание меняет слот; порты создают провода только типа ${busType}.`)}"`;

    return `
      <g class="module module--side-busbar module--side-busbar-${typeClass}${isGhost ? ' module--ghost' : ''}${isInvalidGhost ? ' module--ghost-invalid' : ''}${isPending ? ' is-pending' : ''}${isLive ? ' is-bus-live' : ''}${module.groupId ? ' is-grouped' : ''}"
         data-module-id="${escapeHtml(module.id)}" transform="translate(${x} ${y})"
         style="--module-accent:${color}" ${interactiveAttributes}>
        <title>${escapeHtml(`${module.tag} · ${module.name}`)}</title>
        <rect class="module-shadow-plate" x="1" y="3" width="${width}" height="${MODULE_HEIGHT}" rx="9"/>
        <rect class="side-busbar-body" x="0" y="0" width="${width}" height="${MODULE_HEIGHT}" rx="9"
              stroke="${color}"/>
        <path class="side-busbar-band" d="M 0 9 Q 0 0 9 0 H ${width - 9} Q ${width} 0 ${width} 9 V 27 H 0 Z"
              fill="${color}"/>
        <text class="side-busbar-tag ${tagTextClass(color)}" x="${width / 2}" y="19">${escapeHtml(module.tag)}</text>
        <line class="side-busbar-divider" x1="6" y1="29" x2="${width - 6}" y2="29"/>
        <rect class="side-busbar-plate side-busbar-plate--${typeClass}" x="${plateX}" y="6"
              width="10" height="${MODULE_HEIGHT - 12}" rx="4"/>
        <line class="side-busbar-plate-edge" x1="${plateX + 2}" y1="10" x2="${plateX + 2}"
              y2="${MODULE_HEIGHT - 10}"/>
        <text class="side-busbar-label side-busbar-label--${typeClass}" x="${width / 2}" y="${labelY}">${busType}</text>
        <text class="module-width" x="${widthX}" y="${MODULE_HEIGHT - 8}">1P</text>
        ${deleteButton}
        <rect class="module-focus-ring" x="-4" y="-4" width="${width + 8}" height="${MODULE_HEIGHT + 8}"
              rx="13" fill="none" stroke="${color}"/>
        ${pendingBadge}
        ${portsMarkup}
      </g>`;
  }

  function isModuleOverloaded(module) {
    return isSimulationOn() && Boolean(module?.overloaded);
  }

  function overloadWarningMarkup(overloaded, width) {
    return overloaded
      ? `<text class="module-warning" x="${(width - 7).toFixed(1)}" y="13"
              text-anchor="end" aria-label="Перегрузка">⚠️</text>`
      : '';
  }

  // Потребитель: 1P-корпус с значком лампочки и подписью мощности.
  // Мощность редактируется двойным кликом и сохраняется в модуле.
  function buildLoadModuleMarkup(module, x, y, options) {
    const { isGhost, isInvalidGhost, isPending, color, portsMarkup = '' } = options;
    const width = module.width * MODULE_UNIT;
    const radius = 9;
    const overloaded = !isGhost && isModuleOverloaded(module);
    const power = formatPower(module.power);
    const bottomCount = clamp(portsForModule(module).bottom, 1, 8);
    const showParams = isShowingParams() && isSimulationOn();

    const terminalMarkup = Array.from({ length: bottomCount }, (_, index) => {
      const center = ((index + 1) * width) / (bottomCount + 1);
      return `
        <g class="module-terminal" transform="translate(${center.toFixed(1)} ${MODULE_HEIGHT - 12})">
          <circle class="module-terminal-head" r="4.4"/>
          <path class="module-terminal-cross" d="M -2.2 0 H 2.2 M 0 -2.2 V 2.2"/>
        </g>`;
    }).join('');

    const deleteButton = isGhost ? '' : `
      <g class="module-delete" data-delete-module="${escapeHtml(module.id)}"
         transform="translate(${width - 11} ${MODULE_HEIGHT - 12})" tabindex="0" role="button"
         aria-label="${escapeHtml(`Удалить модуль ${module.tag}`)}">
        <circle class="module-delete-hit" r="14"/>
        <circle class="module-delete-bg" r="8.5"/>
        <path class="module-delete-x" d="M -2.7 -2.7 L 2.7 2.7 M 2.7 -2.7 L -2.7 2.7"/>
      </g>`;

    const interactiveAttributes = isGhost
      ? 'aria-hidden="true"'
      : `tabindex="0" role="group"
         aria-label="${escapeHtml(`${module.tag}: ${module.name}, мощность ${power}. Двойной клик — изменить мощность, порты сверху и снизу создают провода.`)}"`;

    return `
      <g class="module module--body-light module--load${isGhost ? ' module--ghost' : ''}${isInvalidGhost ? ' module--ghost-invalid' : ''}${isPending ? ' is-pending' : ''}${overloaded ? ' is-overloaded' : ''}${module.groupId ? ' is-grouped' : ''}"
         data-module-id="${escapeHtml(module.id)}" transform="translate(${x} ${y})"
         style="--module-accent:${color}" ${interactiveAttributes}>
        <title>${escapeHtml(`${module.tag} · ${module.name} · ${power}${overloaded ? ' · перегрузка' : ''}`)}</title>
        <rect class="module-shadow-plate" x="1" y="3" width="${width}" height="${MODULE_HEIGHT}" rx="${radius}"/>
        <rect class="module-card" x="0" y="0" width="${width}" height="${MODULE_HEIGHT}" rx="${radius}"
              stroke="${color}"/>
        <rect class="module-gloss" x="1.5" y="1.5" width="${width - 3}" height="34" rx="7"/>
        <path class="module-band" d="M 0 ${radius} Q 0 0 ${radius} 0 H ${width - radius} Q ${width} 0 ${width} ${radius} V 30 H 0 Z" fill="${color}"/>
        <path class="module-band-outline"
              d="M 0 ${radius} Q 0 0 ${radius} 0 H ${width - radius} Q ${width} 0 ${width} ${radius} V 30 H 0 Z"/>
        <text class="module-band-text ${tagTextClass(color)}" x="${width / 2}" y="21">${escapeHtml(module.tag)}</text>
        ${overloadWarningMarkup(overloaded, width)}
        <g class="load-icon" transform="translate(${(width / 2).toFixed(1)} 68)">
          <path class="load-bulb-glass"
                d="M 0 -16 C -10 -16 -16 -9 -16 0 C -16 7 -12 11 -8 15 H 8 C 12 11 16 7 16 0 C 16 -9 10 -16 0 -16 Z"/>
          <path class="load-bulb-filament" d="M -6 5 L -2 -3 L 2 5 L 6 -3"/>
          <rect class="load-bulb-base" x="-7" y="15" width="14" height="5" rx="1.5"/>
          <path class="load-bulb-rays"
                d="M 0 -23 V -19 M -14 -17 L -11 -14 M 14 -17 L 11 -14 M -19 0 H -15 M 19 0 H 15"/>
        </g>
        <text class="module-name" x="${width / 2}" y="109">${escapeHtml(truncateLabel(module.name, 8))}</text>
        ${showParams ? `<text class="module-power${overloaded ? ' is-overloaded' : ''}" x="${width / 2}" y="128">${escapeHtml(power)}</text>` : ''}
        <rect class="module-terminal-panel" x="1" y="${MODULE_HEIGHT - 22}" width="${width - 2}" height="21" rx="5"/>
        <line class="module-divider" x1="7" y1="${MODULE_HEIGHT - 19}" x2="${width - 7}" y2="${MODULE_HEIGHT - 19}"/>
        ${terminalMarkup}
        <text class="module-width" x="7" y="${MODULE_HEIGHT - 7}">${module.width}P</text>
        ${deleteButton}
        <rect class="module-focus-ring" x="-4" y="-4" width="${width + 8}" height="${MODULE_HEIGHT + 8}"
              rx="13" fill="none" stroke="${color}"/>
        ${portsMarkup}
      </g>`;
  }

  function buildModuleMarkup(module, x, index, isInvalidGhost = false, y = RAIL.moduleY, portContext = null) {
    const width = module.width * MODULE_UNIT;
    const isGhost = Boolean(module.__ghost);
    const color = safeColor(module.color) || WIRE_COLORS[index % WIRE_COLORS.length];
    const isPending = !isGhost && (
      activePort?.moduleId === module.id || pendingWire?.moduleId === module.id
    );
    // Порты собираются в той же функции, что и корпус, и вставляются прямо
    // в его <g> — они никогда не попадают в соседний слой или на (0,0).
    const portsMarkup = portContext
      ? buildModulePortsMarkup(
        module, width, portContext.occupancy, portContext.phases
      )
      : '';
    if (isLoadModule(module)) {
      return buildLoadModuleMarkup(module, x, y, {
        isGhost, isInvalidGhost, isPending, color, index, portsMarkup
      });
    }
    if (isBusbarModule(module)) {
      const counts = portsForModule(module);
      if (counts.left > 0 || counts.right > 0) {
        return buildSideBusbarModuleMarkup(module, x, y, {
          isGhost, isInvalidGhost, isPending, portsMarkup
        });
      }
      return buildBusbarModuleMarkup(module, x, y, {
        isGhost, isInvalidGhost, isPending, portsMarkup
      });
    }
    const widthLabel = `${module.width}P`;
    const modulesWord = plural(module.width, ['модуль', 'модуля', 'модулей']);
    const verticalName = width < 60;
    const panelCenterX = verticalName ? width * 0.68 : width / 2;
    const bandHeight = 30;
    const radius = 9;
    const bodyVariant = MODULE_BODY_VARIANTS[module.type] || 'standard';
    const rating = moduleRating(module);
    const brand = moduleBrand(module);
    const bottomCount = clamp(portsForModule(module).bottom, 1, 8);
    const switchable = moduleHasSwitch(module);
    const isOn = module.isOn !== false;
    const overloaded = !isGhost && isModuleOverloaded(module);

    const bandPath = `M 0 ${radius} Q 0 0 ${radius} 0 H ${width - radius} Q ${width} 0 ${width} ${radius} V ${bandHeight} H 0 Z`;
    const nameY = switchable
      ? (verticalName ? MODULE_HEIGHT - 52 : 99)
      : MODULE_HEIGHT / 2 + 5;
    const nameX = verticalName ? width * (switchable ? 0.21 : 0.31) : width / 2;
    const nameText = switchable && verticalName ? truncateLabel(module.name, 13) : module.name;
    const nameTransform = verticalName
      ? `translate(${nameX.toFixed(1)} ${nameY}) rotate(-90)`
      : '';
    const circuit = !verticalName && !switchable
      ? `<path class="module-circuit" d="M ${width / 2 - 15} 63 H ${width / 2 - 5}
             M ${width / 2 + 5} 63 H ${width / 2 + 15}
             M ${width / 2 - 5} 63 L ${width / 2 + 4} 56"
             stroke="${color}"/>
         <circle cx="${width / 2}" cy="63" r="2" fill="${color}" opacity="0.38"/>`
      : '';

    // Рычажок занимает 66% ширины модуля и 20% его высоты. У многополюсных
    // модулей он один на весь корпус — так проще и аккуратнее читается.
    const switchWidth = Math.max(24, width * 0.66);
    const switchHeight = 32;
    const switchTravel = 12;
    const switchTrackPadding = 4;
    const switchTrackWidth = switchWidth + switchTrackPadding * 2;
    const switchTrackHeight = switchHeight + switchTravel + switchTrackPadding * 2;
    const switchTrackX = (width - switchTrackWidth) / 2;
    const switchTrackY = 34;
    const switchX = (width - switchWidth) / 2;
    const switchY = switchTrackY + switchTrackPadding + (isOn ? 0 : switchTravel);
    const switchRadius = 7;
    const switchTrackRadius = 10;
    const switchStripeHalf = switchWidth * 0.22;
    const switchStripeY = switchY + switchHeight / 2;
    const switchCenterX = width / 2;

    const switchMarkup = switchable
      ? `<g class="module-switch" data-state="${isOn ? 'on' : 'off'}"
            ${isGhost ? 'aria-hidden="true"' : `data-toggle-module="${escapeHtml(module.id)}"
            tabindex="0" role="switch" aria-checked="${isOn}"
            aria-label="${escapeHtml(`${isOn ? 'Выключить' : 'Включить'} модуль ${module.tag}: ${module.name}`)}"`}>
           <title>${escapeHtml(`${module.tag}: ${isOn ? 'ВКЛ' : 'ОТКЛ'} · нажмите, чтобы ${isOn ? 'выключить' : 'включить'}`)}</title>
           <rect class="module-switch-hit" x="${switchTrackX.toFixed(1)}" y="${switchTrackY}"
                 width="${switchTrackWidth.toFixed(1)}" height="${switchTrackHeight}" rx="${switchTrackRadius}"/>
           <rect class="module-switch-track" x="${switchTrackX.toFixed(1)}" y="${switchTrackY}"
                 width="${switchTrackWidth.toFixed(1)}" height="${switchTrackHeight}" rx="${switchTrackRadius}"/>
           <rect class="module-switch-lever" x="${switchX.toFixed(1)}" y="${switchY.toFixed(1)}"
                 width="${switchWidth.toFixed(1)}" height="${switchHeight}" rx="${switchRadius}"/>
           <line class="module-switch-stripe" x1="${(switchCenterX - switchStripeHalf).toFixed(1)}" y1="${switchStripeY.toFixed(1)}"
                 x2="${(switchCenterX + switchStripeHalf).toFixed(1)}" y2="${switchStripeY.toFixed(1)}"/>
         </g>`
      : '';

    const terminalMarkup = Array.from({ length: bottomCount }, (_, index) => {
      const center = ((index + 1) * width) / (bottomCount + 1);
      return `
        <g class="module-terminal" transform="translate(${center.toFixed(1)} ${MODULE_HEIGHT - 12})">
          <circle class="module-terminal-head" r="4.4"/>
          <path class="module-terminal-cross" d="M -2.2 0 H 2.2 M 0 -2.2 V 2.2"/>
        </g>`;
    }).join('');

    const deleteButton = isGhost ? '' : `
      <g class="module-delete" data-delete-module="${escapeHtml(module.id)}"
         transform="translate(${width - 11} ${MODULE_HEIGHT - 12})" tabindex="0" role="button"
         aria-label="${escapeHtml(`Удалить модуль ${module.tag}`)}">
        <circle class="module-delete-hit" r="14"/>
        <circle class="module-delete-bg" r="8.5"/>
        <path class="module-delete-x" d="M -2.7 -2.7 L 2.7 2.7 M 2.7 -2.7 L -2.7 2.7"/>
      </g>`;

    const pendingBadge = isPending
      ? `<g class="module-pending-badge" transform="translate(3 -12)">
           <circle cx="8" cy="8" r="8"/>
           <text x="8" y="11.1">A</text>
         </g>`
      : '';

    const interactiveAttributes = isGhost
      ? 'aria-hidden="true"'
      : `tabindex="0" role="group"
         aria-label="${escapeHtml(`${module.tag}: ${module.name}, ширина ${module.width} ${modulesWord}.${switchable ? ` Сейчас ${isOn ? 'включён' : 'отключён'}.` : ''} Перетаскивание меняет слот; порты сверху и снизу создают провода.`)}"`;

    return `
      <g class="module module--body-${bodyVariant}${isGhost ? ' module--ghost' : ''}${isInvalidGhost ? ' module--ghost-invalid' : ''}${isPending ? ' is-pending' : ''}${overloaded ? ' is-overloaded' : ''}${module.groupId ? ' is-grouped' : ''}"
         data-module-id="${escapeHtml(module.id)}" transform="translate(${x} ${y})"
         style="--module-accent:${color}" ${interactiveAttributes}>
        <title>${escapeHtml(`${module.tag} · ${module.name}`)}</title>
        <rect class="module-shadow-plate" x="1" y="3" width="${width}" height="${MODULE_HEIGHT}" rx="${radius}"/>
        <rect class="module-card" x="0" y="0" width="${width}" height="${MODULE_HEIGHT}" rx="${radius}"
              stroke="${color}"/>
        <rect class="module-gloss" x="1.5" y="1.5" width="${width - 3}" height="34" rx="7"/>
        <path class="module-band" d="${bandPath}" fill="${color}"/>
        <path class="module-band-outline" d="${bandPath}"/>
        <text class="module-band-text ${tagTextClass(color)}" x="${width / 2}" y="${bandHeight - 9}">${escapeHtml(module.tag)}</text>
        ${overloadWarningMarkup(overloaded, width)}
        ${switchMarkup}
        ${circuit}
        <text class="module-rating" x="${panelCenterX.toFixed(1)}" y="${MODULE_HEIGHT - 50}">${escapeHtml(rating)}</text>
        <text class="module-brand" x="${panelCenterX.toFixed(1)}" y="${MODULE_HEIGHT - 41}">${escapeHtml(brand)}</text>
        <text class="module-name${verticalName ? ' is-vertical' : ''}${switchable && verticalName ? ' is-switch-vertical' : ''}"
              ${verticalName ? `transform="${nameTransform}"` : `x="${width / 2}" y="${nameY}"`}>${escapeHtml(nameText)}</text>
        <rect class="module-terminal-panel" x="1" y="${MODULE_HEIGHT - 22}" width="${width - 2}" height="21" rx="5"/>
        <line class="module-divider" x1="7" y1="${MODULE_HEIGHT - 19}" x2="${width - 7}" y2="${MODULE_HEIGHT - 19}"/>
        ${terminalMarkup}
        <text class="module-width" x="7" y="${MODULE_HEIGHT - 7}">${widthLabel}</text>
        ${deleteButton}
        <rect class="module-focus-ring" x="-4" y="-4" width="${width + 8}" height="${MODULE_HEIGHT + 8}"
              rx="13" fill="none" stroke="${color}"/>
        ${pendingBadge}
        ${portsMarkup}
      </g>`;
  }

  function buildPreview() {
    const rails = project.rails.map((rail) => ({
      rail,
      modules: rail.modules.slice(),
      ghostId: null,
      overflow: false,
      ghostInvalid: false,
      required: usedWidth(rail),
      dropSlot: null
    }));
    const idle = () => ({
      rails,
      ghostId: null,
      overRail: false,
      activeRailId: null,
      overflow: false,
      collision: false,
      dropSlot: null,
      dropWidth: 0,
      required: 0
    });

    if (!dragState || !dragState.overRail) return idle();
    const targetRail = railById(dragState.targetRailId);
    if (!targetRail) return idle();

    // Склейка: все участники снимаются со старых мест и показываются
    // призраками сразу на новых — видно, куда встанет вся группа целиком.
    if (dragState.groupId && dragState.groupMemberIds?.length > 1 &&
        dragState.groupPlacements?.length) {
      const excluded = new Set(dragState.groupMemberIds);
      rails.forEach((item) => {
        item.modules = item.modules.filter((module) => !excluded.has(module.id));
      });

      let collision = false;
      let firstGhostId = null;
      dragState.groupPlacements.forEach((placement) => {
        const source = moduleById(placement.id);
        const item = rails.find((entry) => entry.rail.id === placement.railId);
        if (!source || !item) {
          collision = true;
          return;
        }
        if (!placement.valid) collision = true;
        const ghost = {
          ...source,
          __ghost: true,
          __ghostInvalid: !placement.valid,
          slot: clamp(placement.slot, 0, Math.max(0, item.rail.capacity - source.width))
        };
        item.modules.push(ghost);
        item.ghostId = ghost.id;
        item.ghostInvalid = item.ghostInvalid || !placement.valid;
        item.dropSlot = dragState.dropSlot;
        if (!firstGhostId) firstGhostId = ghost.id;
      });

      rails.forEach((item) => {
        item.required = item.modules.reduce(
          (max, module) => Math.max(max, module.slot + module.width), 0
        );
        item.overflow = item.required > item.rail.capacity;
      });
      const active = rails.find((entry) => entry.rail.id === targetRail.id);
      return {
        rails,
        ghostId: firstGhostId,
        overRail: true,
        activeRailId: targetRail.id,
        overflow: Boolean(active?.overflow),
        collision,
        dropSlot: dragState.dropSlot,
        dropWidth: dragState.width,
        required: active?.required || 0,
        capacity: targetRail.capacity
      };
    }

    let ghost;
    if (dragState.kind === 'reorder') {
      const source = railOfModule(dragState.moduleId)?.module;
      if (!source) return idle();
      // Оставляем реальный id: провода продолжают следовать за модулем при перетаскивании.
      ghost = { ...source, __ghost: true };
    } else {
      const libraryItem = LIBRARY_BY_ID.get(dragState.libraryId);
      if (!libraryItem) return idle();
      ghost = {
        __ghost: true,
        id: '__drag_ghost__',
        libraryId: libraryItem.id,
        type: libraryItem.type,
        name: libraryItem.name,
        width: libraryItem.width,
        slot: 0,
        color: libraryItem.color,
        ports: portsForModule(libraryItem),
        isOn: true,
        isBusbar: libraryItem.isBusbar === true,
        busType: libraryItem.busType || null,
        busbarType: libraryItem.busType || libraryItem.busbarType || null,
        tag: dragState.ghostTag || generateTag(libraryItem.tagPrefix, allModules()),
        description: ''
      };
    }

    const excludedId = dragState.kind === 'reorder' ? dragState.moduleId : null;
    const dropSlot = dragState.dropSlot;
    const collision = !canPlaceModule(targetRail, dropSlot, dragState.width, excludedId);
    ghost.slot = dropSlot;
    ghost.__ghostInvalid = collision;

    for (const item of rails) {
      if (dragState.kind === 'reorder') {
        item.modules = item.modules.filter((module) => module.id !== dragState.moduleId);
      }
      if (item.rail.id === targetRail.id) {
        item.modules.push(ghost);
        item.dropSlot = dropSlot;
        item.ghostId = ghost.id;
        item.ghostInvalid = collision;
      }
      item.required = item.modules.reduce(
        (max, module) => Math.max(max, module.slot + module.width), 0
      );
      item.overflow = item.required > item.rail.capacity;
    }

    const active = rails.find((item) => item.rail.id === targetRail.id);
    return {
      rails,
      ghostId: ghost.id,
      overRail: true,
      activeRailId: targetRail.id,
      overflow: Boolean(active?.overflow),
      collision,
      dropSlot,
      dropWidth: dragState.width,
      required: active?.required || 0,
      capacity: targetRail.capacity
    };
  }

  /* --------------------------- Zoom / Pan ----------------------------- */

  function baseCanvasSize() {
    return { width: canvasWidth(), height: canvasHeight() };
  }

  // Текущая область просмотра в координатах схемы.
  function viewRect() {
    const base = baseCanvasSize();
    return {
      x: viewState.x,
      y: viewState.y,
      width: base.width / viewState.zoom,
      height: base.height / viewState.zoom
    };
  }

  // Не даём уехать далеко за пределы схемы. Ограничение одно и то же для
  // любого масштаба: viewBox должен перекрывать не менее 85% пластины (или
  // 85% самого viewBox, если он меньше пластины). Формула с min(width, base)
  // корректно работает и при zoom < 1, когда область просмотра БОЛЬШЕ схемы:
  // раньше в этом случае вид принудительно центрировался и панорамирование
  // полностью «откатывалось» на каждом applyView().
  const VIEW_VISIBLE_FRACTION = 0.85;

  function clampAxis(start, size, baseSize) {
    const visible = Math.min(size, baseSize) * VIEW_VISIBLE_FRACTION;
    return clamp(start, visible - size, baseSize - visible);
  }

  function clampView() {
    // Защита от нестабильных чисел: при некорректном зуме/сдвиге сбрасываем
    // вид, чтобы в viewBox никогда не попадали NaN или Infinity.
    if (!Number.isFinite(viewState.zoom) || viewState.zoom <= 0) viewState.zoom = 1;
    viewState.zoom = clamp(viewState.zoom, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
    if (!Number.isFinite(viewState.x)) viewState.x = 0;
    if (!Number.isFinite(viewState.y)) viewState.y = 0;

    const base = baseCanvasSize();
    const width = base.width / viewState.zoom;
    const height = base.height / viewState.zoom;
    viewState.x = clampAxis(viewState.x, width, base.width);
    viewState.y = clampAxis(viewState.y, height, base.height);
  }

  function viewNumber(value) {
    return String(Number(value.toFixed(3)));
  }

  function applyView() {
    clampView();
    const rect = viewRect();
    dom.canvas.setAttribute('viewBox', [
      viewNumber(rect.x), viewNumber(rect.y),
      viewNumber(rect.width), viewNumber(rect.height)
    ].join(' '));
    if (dom.zoomLevel) {
      dom.zoomLevel.textContent = `${Math.round(viewState.zoom * 100)}%`;
    }
    // Оверлеи позиционируются в экранных пикселях — после смены viewBox
    // их нужно пересчитать, иначе тултипы «отстанут» от портов.
    positionOverlays();
  }

  /* Универсальный перевод координат указателя в координаты SVG-холста.
     getScreenCTM().inverse() автоматически учитывает текущий viewBox — то есть
     зум и панорамирование — а также CSS-масштаб и прокрутку страницы. Именно
     поэтому все интерактивные элементы (модули, порты, фон, зум и панорама)
     работают на любом масштабе, а не только при 100%.
     evt — любое pointer/mouse-событие с полями clientX/clientY.
     Необязательная matrix — заранее сохранённая прямая матрица: она нужна
     при панорамировании, когда viewBox меняется прямо во время жеста. */
  function getSVGCoords(evt, matrix = null) {
    const pt = dom.canvas.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const screenMatrix = matrix || dom.canvas.getScreenCTM();

    // Нормальный путь: обратная CTM уже включает масштаб viewBox, панораму
    // и CSS-преобразования — дельты мыши переводятся в координаты схемы
    // корректно при любом зуме (в том числе < 100%).
    if (screenMatrix && [screenMatrix.a, screenMatrix.b, screenMatrix.c,
      screenMatrix.d, screenMatrix.e, screenMatrix.f].every(Number.isFinite)) {
      const result = pt.matrixTransform(screenMatrix.inverse());
      if (Number.isFinite(result.x) && Number.isFinite(result.y)) return result;
    }

    // Резервный путь на случай отсутствия/вырожденной матрицы: переводим
    // экранные пиксели через масштаб viewBox / boundingClientRect — ровно та
    // же формула, что используется для сдвига при панорамировании.
    const rect = dom.canvas.getBoundingClientRect();
    const view = viewRect();
    const scaleX = rect.width ? view.width / rect.width : 1;
    const scaleY = rect.height ? view.height / rect.height : 1;
    return {
      x: view.x + (evt.clientX - rect.left) * scaleX,
      y: view.y + (evt.clientY - rect.top) * scaleY
    };
  }

  // Узкий адаптер для вызовов, где есть только числа, а не событие.
  function svgPointFromClient(clientX, clientY, matrix = null) {
    return getSVGCoords({ clientX, clientY }, matrix);
  }

  // Общая часть зума: anchor уже переведён в координаты схемы через
  // getSVGCoords, поэтому точка под курсором остаётся на месте при любом зуме.
  function applyZoom(anchor, fractionX, fractionY, factor) {
    if (!project || !anchor) return;
    const nextZoom = clamp(viewState.zoom * factor, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
    if (Math.abs(nextZoom - viewState.zoom) < 1e-6) return;

    const base = baseCanvasSize();
    viewState.zoom = nextZoom;
    viewState.x = anchor.x - fractionX * base.width / nextZoom;
    viewState.y = anchor.y - fractionY * base.height / nextZoom;
    applyView();
  }

  // Зум колесиком: координаты берём из самого события.
  function zoomAtEvent(event, factor) {
    const anchor = getSVGCoords(event);
    const rect = dom.canvas.getBoundingClientRect();
    const fractionX = rect.width ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5;
    const fractionY = rect.height ? clamp((event.clientY - rect.top) / rect.height, 0, 1) : 0.5;
    applyZoom(anchor, fractionX, fractionY, factor);
  }

  // Зум кнопками +/-: точка — центр холста, события как такового нет.
  function zoomAtClient(clientX, clientY, factor) {
    const anchor = svgPointFromClient(clientX, clientY);
    const rect = dom.canvas.getBoundingClientRect();
    const fractionX = rect.width ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0.5;
    const fractionY = rect.height ? clamp((clientY - rect.top) / rect.height, 0, 1) : 0.5;
    applyZoom(anchor, fractionX, fractionY, factor);
  }

  function zoomByStep(factor) {
    if (editing) commitInlineEdit();
    const rect = dom.canvas.getBoundingClientRect();
    zoomAtClient(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function resetView() {
    if (editing) commitInlineEdit();
    viewState.x = 0;
    viewState.y = 0;
    viewState.zoom = 1;
    applyView();
  }

  function onCanvasWheel(event) {
    if (!project) return;
    // Зум во время ввода закрывает поле, сохраняя текст (как blur).
    if (editing) commitInlineEdit();
    event.preventDefault();
    const rect = dom.canvas.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16
      : event.deltaMode === 2 ? (rect.height || SVG_BASE_HEIGHT)
      : 1;
    const delta = clamp(event.deltaY * unit, -240, 240);
    if (!delta) return;
    zoomAtEvent(event, Math.exp(-delta * 0.0022));
  }

  // Общий старт жеста. pointerId === null означает, что панорамирование
  // запущено средней кнопкой мыши: тогда движение слушают window-события
  // mousemove / mouseup (и mouseleave для ухода курсора за окно).
  function startPan(event, pointerId = null) {
    if (panState || gesture || dragState) return false;
    // Панорамирование (средняя кнопка / Пробел) сохраняет введённую подпись.
    if (editing) commitInlineEdit();

    // Фиксируем матрицу на старте жеста: пока viewBox меняется, она остаётся
    // прежней. Разница в координатах схемы точно равна смещению холста, а сама
    // матрица уже включает текущий zoom и CSS-масштаб (при зуме 200% экранный
    // пиксель даёт вдвое меньший сдвиг в координатах схемы — холст едет
    // ровно под курсором на любом масштабе).
    const screenMatrix = dom.canvas.getScreenCTM();
    if (!screenMatrix || ![screenMatrix.a, screenMatrix.b, screenMatrix.c,
      screenMatrix.d, screenMatrix.e, screenMatrix.f].every(Number.isFinite)) return false;
    const startPoint = getSVGCoords(event, screenMatrix);
    if (!startPoint || !Number.isFinite(startPoint.x) || !Number.isFinite(startPoint.y)) return false;

    panState = {
      pointerId,
      screenMatrix,
      startPoint,
      startView: { x: viewState.x, y: viewState.y },
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    dom.svgWrap.classList.add('is-panning');
    document.body.classList.add('is-panning');
    if (pointerId !== null) {
      try { dom.svgWrap.setPointerCapture(pointerId); } catch (error) { /* ignore */ }
    }
    return true;
  }

  // Пробел + левая кнопка — дополнительный способ панорамирования.
  // Среднюю кнопку обрабатывает onPanMouseDown: только там preventDefault()
  // надёжно подавляет системный «кружок автоскролла» браузера.
  function onPanPointerDown(event) {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !spaceHeld) return;
    // Пробел + клик по кнопке/порту должен оставаться обычным кликом.
    if (event.target.closest?.(
      'button, a, input, [data-port-id], [data-toggle-module], [data-toggle-source]'
    )) return;
    if (!startPan(event, event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onPanMouseDown(event) {
    if (event.button !== 1) return; // только колесико (средняя кнопка)
    // ВАЖНО: без этого Chrome включает автоскролл и показывает иконку
    // со стрелками, а страница едет вместе с холстом.
    event.preventDefault();
    event.stopPropagation();
    startPan(event, null);
  }

  function movePan(event) {
    if (!panState) return;
    if (!panState.moved &&
        Math.hypot(event.clientX - panState.startX, event.clientY - panState.startY) < 2) return;

    // Матрица зафиксирована в начале жеста: разница в SVG-координатах
    // равна смещению холста, независимо от текущего viewBox и DPI.
    // Это эквивалентно формуле dx = (clientX - startX) * scale, где
    // scale = viewBox.width / boundingClientRect.width: обратная CTM даёт
    // тот же масштаб, но точнее учитывает CSS-размер и сам viewBox.
    const point = getSVGCoords(event, panState.screenMatrix);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const nextX = panState.startView.x - (point.x - panState.startPoint.x);
    const nextY = panState.startView.y - (point.y - panState.startPoint.y);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;
    panState.moved = true;
    viewState.x = nextX;
    viewState.y = nextY;
    applyView();
  }

  function onPanPointerMove(event) {
    if (!panState || panState.pointerId === null) return;
    if (event.pointerId !== panState.pointerId) return;
    event.preventDefault();
    movePan(event);
  }

  function onPanMouseMove(event) {
    if (!panState || panState.pointerId !== null) return;
    // Завершение жеста — по mouseup / mouseleave / blur (см. биндинги).
    event.preventDefault();
    movePan(event);
  }

  function onPanMouseUp(event) {
    if (event.button === 1) endPan();
  }

  function endPan(event) {
    if (!panState) return;
    if (event && Number.isFinite(event.pointerId) && panState.pointerId !== null &&
        event.pointerId !== panState.pointerId) return;
    if (panState.moved) suppressCanvasClickUntil = performance.now() + 250;
    if (panState.pointerId !== null) {
      try {
        if (dom.svgWrap.hasPointerCapture?.(panState.pointerId)) {
          dom.svgWrap.releasePointerCapture(panState.pointerId);
        }
      } catch (error) { /* ignore */ }
    }
    panState = null;
    dom.svgWrap.classList.remove('is-panning');
    document.body.classList.remove('is-panning');
  }

  function updateCanvasSize() {
    const width = canvasWidth();
    const height = canvasHeight();
    if (dom.canvasSurface) dom.canvasSurface.setAttribute('width', String(width));
    if (dom.canvasSurface) dom.canvasSurface.setAttribute('height', String(height));
    if (dom.canvasGrid) dom.canvasGrid.setAttribute('width', String(width));
    if (dom.canvasGrid) dom.canvasGrid.setAttribute('height', String(height));
    applyView();
  }

  // Подсветка целевых слотов при перетаскивании: показываем, куда именно
  // встанет модуль. Красная — если место занято (перенос будет отменён).
  function buildSlotHighlight(preview) {
    if (!preview.overRail || !Number.isInteger(preview.dropSlot)) return '';
    const railIndex = preview.rails.findIndex((item) => item.rail.id === preview.activeRailId);
    if (railIndex < 0) return '';
    const x = moduleSlotX(preview.dropSlot);
    const y = railModuleY(railIndex);
    return `<rect class="rail-slot-highlight${preview.collision ? ' is-invalid' : ''}" ` +
      `x="${x}" y="${y - 5}" width="${preview.dropWidth * MODULE_UNIT}" ` +
      `height="${MODULE_HEIGHT + 10}" rx="9"/>`;
  }

  // Общая рамка вокруг всех модулей склейки. Строится по тем же позициям,
  // что и сами модули (включая призраков при перетаскивании), поэтому во
  // время drag&drop рамка едет вместе с группой. Группы из одного модуля
  // (например, после удаления соседей) не рисуются.
  function buildGroupBoxesMarkup(preview) {
    const groups = new Map();
    preview.rails.forEach((item, railIndex) => {
      item.modules.forEach((module) => {
        const groupId = safeGroupId(module.groupId);
        if (!groupId) return;
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push({
          x: moduleSlotX(module.slot),
          y: railModuleY(railIndex),
          width: module.width * MODULE_UNIT,
          height: MODULE_HEIGHT
        });
      });
    });

    const boxes = [];
    groups.forEach((rects, groupId) => {
      if (rects.length < 2) return;
      const pad = 9;
      const left = Math.min(...rects.map((rect) => rect.x)) - pad;
      const top = Math.min(...rects.map((rect) => rect.y)) - pad;
      const right = Math.max(...rects.map((rect) => rect.x + rect.width)) + pad;
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) + pad;
      const invalid = Boolean(
        dragState && dragState.groupId === groupId && !dragState.valid
      );
      const shortId = groupId.replace(/^grp_/, '').slice(-6);
      boxes.push(
        `<g class="group-box${invalid ? ' is-invalid' : ''}" data-group-id="${escapeHtml(groupId)}">` +
          `<rect x="${viewNumber(left)}" y="${viewNumber(top)}" ` +
            `width="${viewNumber(right - left)}" height="${viewNumber(bottom - top)}" rx="15"/>` +
          `<text class="group-box-label" x="${viewNumber(left + 4)}" y="${viewNumber(top - 6)}">` +
            `Склейка · ${escapeHtml(shortId)}</text>` +
        `</g>`
      );
    });
    return boxes.join('');
  }

  // Жёлтый стикер с загнутым углом. Текст переносится по словам и обрезается
  // многоточием — как подписи модулей, поэтому длинная заметка не вылезает
  // за пределы бумажки ни на холсте, ни в PNG-экспорте.
  function buildNoteMarkup(note) {
    const lines = fitTextLines(note.text, NOTE_TEXT_MAX_CHARS, NOTE_TEXT_MAX_LINES);
    const textMarkup = lines.length
      ? lines.map((line, index) =>
          `<tspan x="12" dy="${index === 0 ? 0 : NOTE_LINE_HEIGHT}">${escapeHtml(line)}</tspan>`
        ).join('')
      : `<tspan x="12" dy="0" class="note-placeholder">Двойной клик — текст</tspan>`;
    const label = escapeHtml(note.text || 'Пустая заметка');
    const fold = NOTE_WIDTH - 26;
    return `<g class="note${selectedNoteId === note.id ? ' selected' : ''}" data-note-id="${note.id}" ` +
      `transform="translate(${viewNumber(note.x)} ${viewNumber(note.y)})" ` +
      `tabindex="0" role="button" aria-label="Заметка: ${label}">` +
      `<rect class="note-shadow" x="1" y="3" width="${NOTE_WIDTH}" height="${NOTE_HEIGHT}" rx="5"/>` +
      `<path class="note-paper" d="M0 5 Q0 0 5 0 H${fold} L${NOTE_WIDTH} 26 ` +
        `V${NOTE_HEIGHT - 5} Q${NOTE_WIDTH} ${NOTE_HEIGHT} ${NOTE_WIDTH - 5} ${NOTE_HEIGHT} ` +
        `H5 Q0 ${NOTE_HEIGHT} 0 ${NOTE_HEIGHT - 5} Z"/>` +
      `<path class="note-fold" d="M${fold} 0 L${NOTE_WIDTH} 26 H${fold} Z"/>` +
      `<text class="note-text" x="12" y="27">${textMarkup}</text>` +
      `<g class="note-delete" data-delete-note="${note.id}" tabindex="0" role="button" ` +
        `aria-label="Удалить заметку" title="Удалить заметку">` +
        `<circle class="note-delete-bg" cx="${NOTE_WIDTH - 15}" cy="${NOTE_HEIGHT - 15}" r="9"/>` +
        `<path class="note-delete-mark" d="M${NOTE_WIDTH - 18} ${NOTE_HEIGHT - 18} ` +
          `l6 6m0-6-6 6" stroke-linecap="round"/>` +
      `</g>` +
    `</g>`;
  }

  function renderCanvas() {
    const preview = buildPreview();
    const overRail = preview.overRail;
    const invalid = preview.collision || preview.overflow;

    dom.canvas.classList.toggle('is-overflow', invalid);
    dom.canvas.classList.toggle('is-drop-target', overRail && !invalid);
    dom.canvas.classList.toggle('is-connecting', Boolean(activePort));
    dom.canvasShell.classList.toggle('is-drop-target', overRail && !invalid);
    dom.canvasShell.classList.toggle('is-connecting', Boolean(activePort));
    updateCanvasSize();

    // Каждая перерисовка очищает СОДЕРЖИМОЕ трёх переключаемых и двух
    // статичных групп, но не трогает сами <g>: их классы .hidden/.locked
    // и порядок остаются прежними. Статичные группы не имеют тумблеров.
    for (const key of LAYER_KEYS) {
      const layer = document.getElementById(LAYER_ELEMENT_IDS[key]);
      if (layer) layer.innerHTML = '';
    }
    if (dom.railTrack) dom.railTrack.innerHTML = '';
    if (dom.powerSourceLayer) dom.powerSourceLayer.innerHTML = '';
    if (dom.notesLayer) dom.notesLayer.innerHTML = '';

    const occupancy = getPortOccupancy();
    const phases = computePortPhases();
    const portContext = { occupancy, phases };

    // #rail-track — пластины DIN-реек и подсветка слота. Группа не является
    // слоем: фон реек всегда виден и не блокируется панелью «Слои».
    dom.railTrack.innerHTML = preview.rails
      .map((item, index) => buildRailMarkup(
        item.rail,
        index,
        item.overflow || Boolean(item.ghostInvalid),
        overRail && item.rail.id === preview.activeRailId
      ))
      .join('') + buildSlotHighlight(preview) + buildGroupBoxesMarkup(preview);

    const positions = new Map();
    let globalIndex = 0;
    let moduleMarkup = '';
    let descriptionMarkup = '';
    for (const [railIndex, item] of preview.rails.entries()) {
      const moduleY = railModuleY(railIndex);
      const ordered = item.modules.slice().sort((a, b) => a.slot - b.slot);
      for (const module of ordered) {
        const width = module.width * MODULE_UNIT;
        // X модуля вычисляется из слота, а не из накопленной ширины:
        // пустые слоты между модулями остаются пустыми.
        const x = moduleSlotX(module.slot);
        const position = {
          x,
          center: x + width / 2,
          width,
          y: moduleY,
          railId: item.rail.id,
          railIndex,
          module
        };
        positions.set(module.id, position);
        // Корпус + заводской текст + порты — всё в одном <g> слоя модулей.
        moduleMarkup += buildModuleMarkup(
          module, x, globalIndex, Boolean(module.__ghostInvalid), moduleY, portContext
        );
        // Пользовательское описание уходит в слой подписей.
        const baseline = moduleDescriptionBaseline(module);
        if (baseline !== null) {
          descriptionMarkup += moduleDescriptionMarkup(module, position, baseline);
        }
        globalIndex += 1;
      }
    }
    dom.moduleLayer.innerHTML = moduleMarkup;

    // Источник питания — фиксированный элемент интерфейса со своим текстом,
    // рубильником и пятью портами. Он рендерится в отдельной группе и НЕ
    // входит в #layer-modules: выключение слоя «Модули» его не скроет.
    if (dom.powerSourceLayer) {
      dom.powerSourceLayer.innerHTML = buildSourceMarkup(occupancy, phases);
    }
    updateSelectionClasses();

    // #layer-wires — только polyline проводов и их хало; превью тоже polyline.
    // #layer-labels — только пользовательские подписи: названия проводов
    // (бейджи и маркировка) и описания модулей.
    const wireMarkup = buildWiresMarkup(buildWireLayouts(positions));
    dom.wireLayer.innerHTML = wireMarkup.wires + buildPreviewWire(positions);
    dom.labelLayer.innerHTML = wireMarkup.labels + descriptionMarkup;

    // Стикеры лежат поверх всех слоёв и не участвуют в склейке/проводах.
    if (dom.notesLayer) {
      dom.notesLayer.innerHTML = notes().map(buildNoteMarkup).join('');
    }

    if (dom.portPhaseTooltip) dom.portPhaseTooltip.hidden = true;
    positionOverlays();

    const showAlert = overRail && invalid;
    dom.railAlert.hidden = !showAlert;
    if (showAlert) {
      if (preview.collision) {
        dom.railAlertText.textContent = 'Место занято — перенос невозможен';
      } else {
        const missing = Math.max(1, preview.required - preview.capacity);
        dom.railAlertText.textContent = `Не помещается: не хватает ${missing} P`;
      }
    }

    dom.emptyState.hidden = !(allModules().length === 0 && !overRail);
  }

  function scheduleCanvasRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => {
      renderScheduled = false;
      renderCanvas();
    });
  }

  function buildSpecification() {
    const grouped = new Map();

    allModules().forEach((module) => {
      const key = priceKeyFor(module);
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          name: module.name,
          typeLabel: typeLabelFor(module),
          width: module.width,
          color: module.color,
          brand: moduleBrand(module),
          sku: moduleSku(module),
          price: modulePrice(module),
          count: 0,
          tags: [],
          descriptions: [],
          switchable: false,
          onCount: 0,
          offCount: 0
        });
      }
      const group = grouped.get(key);
      group.count += 1;
      if (module.tag) group.tags.push(module.tag);
      const description = typeof module.description === 'string' ? module.description.trim() : '';
      if (description && !group.descriptions.includes(description)) group.descriptions.push(description);
      if (moduleHasSwitch(module)) {
        group.switchable = true;
        if (module.isOn === false) group.offCount += 1;
        else group.onCount += 1;
      }
    });

    return [...grouped.values()].sort((left, right) => {
      const leftOrder = LIBRARY_ORDER.has(left.key) ? LIBRARY_ORDER.get(left.key) : 999;
      const rightOrder = LIBRARY_ORDER.has(right.key) ? LIBRARY_ORDER.get(right.key) : 999;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.name.localeCompare(right.name, 'ru');
    });
  }

  function specificationStatusLabel(item) {
    if (!item.switchable) return '—';
    if (item.offCount === 0) return 'ВКЛ';
    if (item.onCount === 0) return 'ОТКЛ';
    return `ВКЛ: ${item.onCount}, ОТКЛ: ${item.offCount}`;
  }

  function renderSpecification() {
    const specification = buildSpecification();
    const totalModules = allModules().length;

    if (specification.length === 0) {
      dom.specBody.innerHTML = `
        <tr>
          <td colspan="5" class="spec-empty">Пока пусто. Перетащите компонент из библиотеки на DIN-рейку.</td>
        </tr>`;
    } else {
      dom.specBody.innerHTML = specification.map((item) => `
        <tr>
          <td>
            <span class="spec-name">
              <span class="spec-dot" style="--spec-color:${safeColor(item.color) || '#2563eb'}"></span>
              <span class="spec-name-copy">
                <strong>${escapeHtml(item.name)}</strong>
                <span class="spec-sub">${escapeHtml(item.typeLabel)} · ${item.width}P</span>
              </span>
            </span>
          </td>
          <td class="brand-col" title="${escapeHtml(item.brand || '')}">${escapeHtml(item.brand || '—')}</td>
          <td class="sku-col" title="${escapeHtml(item.sku || '')}">${escapeHtml(item.sku || '—')}</td>
          <td class="tag-col">
            <span class="spec-tags">
              ${item.tags.map((tag) => `<span class="spec-tag">${escapeHtml(tag)}</span>`).join('')}
            </span>
          </td>
          <td class="count-col">
            <span class="spec-qty">${item.count}<span>шт.</span></span>
          </td>
        </tr>`).join('');
    }

    dom.specFoot.hidden = specification.length === 0;
    dom.specTotal.textContent = String(totalModules);
    dom.specMeta.textContent = `${specification.length} ${plural(specification.length, ['позиция', 'позиции', 'позиций'])} · ${totalModules} шт. · ${usedWidth()} P`;

    const wireCounts = getWireCounts();
    if (dom.specRailsTotal) dom.specRailsTotal.textContent = String(project.rails.length);
    if (dom.specModulesTotal) dom.specModulesTotal.textContent = String(totalModules);
    dom.specConnectionsTotal.textContent = String(project.connections.length);
    dom.specWireL1.textContent = String(wireCounts.L1);
    dom.specWireL2.textContent = String(wireCounts.L2);
    dom.specWireL3.textContent = String(wireCounts.L3);
    dom.specWireN.textContent = String(wireCounts.N);
    dom.specWirePE.textContent = String(wireCounts.PE);

    // Расход кабеля пересчитывается при каждом renderAll(): добавление и
    // удаление провода, перенос модуля, смена рейки и т.д.
    const wireLengths = calculateWireLengths();
    if (dom.specCable) dom.specCable.hidden = project.connections.length === 0;
    if (dom.specCableL1) dom.specCableL1.textContent = formatCableLength(wireLengths.L1);
    if (dom.specCableL2) dom.specCableL2.textContent = formatCableLength(wireLengths.L2);
    if (dom.specCableL3) dom.specCableL3.textContent = formatCableLength(wireLengths.L3);
    if (dom.specCableN) dom.specCableN.textContent = formatCableLength(wireLengths.N);
    if (dom.specCablePE) dom.specCablePE.textContent = formatCableLength(wireLengths.PE);
  }

  function renderConnections() {
    dom.connectionsCount.textContent = String(project.connections.length);

    if (project.connections.length === 0) {
      dom.connectionList.innerHTML = `
        <li class="connection-empty">Связей пока нет.<br>Кликните по порту модуля, затем по второму порту и выберите тип провода.</li>`;
      return;
    }

    dom.connectionList.innerHTML = project.connections.map((connection) => {
      const type = WIRE_TYPES[connection.type] || WIRE_TYPES[DEFAULT_WIRE_TYPE];
      const color = wireDisplayColor(connection.type);
      const fromLabel = connectionPortLabel(connection, 'from');
      const toLabel = connectionPortLabel(connection, 'to');
      return `
        <li class="connection-row${connection.id === selectedConnectionId ? ' is-selected' : ''}"
            title="${escapeHtml(connectionLabel(connection))}">
          <span class="connection-color" style="--wire-color:${color}" aria-hidden="true"></span>
          <span class="connection-flow">
            <span class="connection-tag">${escapeHtml(fromLabel)}</span>
            <span class="connection-arrow" aria-hidden="true">→</span>
            <span class="connection-tag">${escapeHtml(toLabel)}</span>
          </span>
          <span class="connection-type wire-type-${type.label.toLowerCase()}">${type.label}</span>
          <button class="remove-connection" type="button" data-remove-connection="${escapeHtml(connection.id)}"
                  aria-label="${escapeHtml(`Удалить провод ${fromLabel} — ${toLabel}`)}"
                  title="Удалить провод">×</button>
        </li>`;
    }).join('');
  }

  function updateMetrics() {
    const used = usedWidth();
    const capacityTotal = project.rails.reduce((total, rail) => total + rail.capacity, 0);
    const free = Math.max(0, capacityTotal - used);
    const percentage = capacityTotal > 0 ? clamp((used / capacityTotal) * 100, 0, 100) : 0;

    dom.railUsage.textContent = `${used} / ${capacityTotal} P`;
    dom.railFree.textContent = free === 0 ? 'Рейки заполнены' : `Свободно ${free} P`;
    dom.railFill.style.width = `${percentage}%`;
    dom.railProgress.setAttribute('aria-valuemax', String(capacityTotal));
    dom.railProgress.setAttribute('aria-valuenow', String(used));
    dom.railMeter.classList.toggle('is-full', free === 0);
  }

  function updateLibraryAvailability() {
    // Модуль можно добавить на любую рейку, где хватает места.
    const free = Math.max(0, ...project.rails.map((rail) => rail.capacity - usedWidth(rail)));
    dom.libraryList.querySelectorAll('.component-card').forEach((card) => {
      const libraryItem = LIBRARY_BY_ID.get(card.dataset.libraryId);
      if (!libraryItem) return;
      const noRoom = libraryItem.width > free;
      card.classList.toggle('is-no-room', noRoom);
      card.title = noRoom
        ? `Недостаточно места: свободно ${free} P. ${libraryItem.description}`
        : libraryItem.description;
    });
  }

  function updateConnectionUI() {
    if (activePort && !isPortRefValid(activePort)) activePort = null;
    if (pendingWire && !isPortRefValid(pendingWire)) pendingWire = null;
    if (!activePort) pendingWire = null;

    dom.cancelConnect.hidden = !activePort;
    dom.canvasShell.classList.toggle('is-connecting', Boolean(activePort));
    dom.canvas.classList.toggle('is-connecting', Boolean(activePort));

    if (notePlacing) {
      dom.connectionHint.textContent = 'Кликните по холсту, чтобы поставить заметку · Esc — отмена';
      updateWireTypeOptions();
      positionOverlays();
      return;
    }

    if (activePort) {
      dom.connectionHint.textContent = pendingWire
        ? 'Выберите тип провода (L1 / L2 / L3 / N / PE)'
        : `Выбран ${portRefLabel(activePort)} — выберите второй порт`;
    } else if (allModules().length === 0) {
      dom.connectionHint.textContent = 'Добавьте модуль, чтобы создать провод';
    } else {
      dom.connectionHint.textContent = 'Кликните по порту, чтобы начать провод';
    }
    updateWireTypeOptions();
    positionOverlays();
  }

  function updateActionState() {
    const hasModules = allModules().length > 0;
    dom.exportCsv.disabled = !hasModules;
    dom.exportCsvSecondary.disabled = !hasModules;
    dom.clearProject.disabled = !hasModules && project.connections.length === 0 && notes().length === 0;
    if (dom.addRail) dom.addRail.disabled = project.rails.length >= MAX_RAILS;

    const picked = selectedModules();
    if (dom.groupBtn) dom.groupBtn.disabled = picked.length < 2;
    if (dom.ungroupBtn) dom.ungroupBtn.disabled = !picked.some((module) => module.groupId);

    updateHistoryButtons();
  }

  function renderAll() {
    closeInlineEditor();
    hideElementTooltip();
    calculatePowerFlow();
    renderCanvas();
    renderSpecification();
    renderConnections();
    updateMetrics();
    updateLibraryAvailability();
    updateConnectionUI();
    updateActionState();
    updateDocumentTitle();
    applyLayerSettings();
    // Открытые вкладки журнала и маркировки тоже пересчитываются при любом
    // изменении проекта (undo/redo, импорт и т. д.).
    if (activeTab === 'journal') renderJournal();
    if (activeTab === 'marking') renderMarking();
  }

  /* --------------------------- Drag & drop ---------------------------- */

  function svgPointFromEvent(event) {
    // Drag & drop работает в координатах схемы: обратная матрица CTM
    // пересчитывается для каждого события и учитывает текущий viewBox.
    return getSVGCoords(event);
  }

  // Координатный поиск порта: страховка для случаев, когда DOM-цель клика
  // перекрыта оверлеем или вложенным элементом. Порты теперь лежат внутри
  // сдвинутых групп модулей, поэтому их локальные cx/cy переводятся в
  // координаты viewBox через матрицы CTM (иначе сравнение было бы неверным).
  function portElementAtPoint(point) {
    if (!point) return null;
    const svgToScreen = dom.canvas.getScreenCTM?.();
    if (!svgToScreen) return null;
    const screenToSvg = svgToScreen.inverse();
    let best = null;
    let bestDistance = Infinity;
    const portElements = [
      ...dom.moduleLayer.querySelectorAll('[data-port-id]'),
      ...(dom.powerSourceLayer
        ? dom.powerSourceLayer.querySelectorAll('[data-port-id]')
        : [])
    ];
    portElements.forEach((portElement) => {
      const dot = portElement.querySelector('.port-dot');
      if (!dot) return;
      const dotToScreen = dot.getScreenCTM?.();
      if (!dotToScreen) return;
      const x = Number(dot.getAttribute('cx'));
      const y = Number(dot.getAttribute('cy'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // локальные координаты порта → координаты viewBox холста
      const matrix = screenToSvg.multiply(dotToScreen);
      const absX = matrix.a * x + matrix.c * y + matrix.e;
      const absY = matrix.b * x + matrix.d * y + matrix.f;
      const hitRadius = Number(portElement.dataset.hitRadius) || PORT_HIT_RADIUS;
      const distance = Math.hypot(point.x - absX, point.y - absY);
      if (distance <= hitRadius && distance < bestDistance) {
        bestDistance = distance;
        best = portElement;
      }
    });
    return best;
  }

  function railIndexAtPoint(point) {
    for (let index = 0; index < project.rails.length; index += 1) {
      const railY = railPlateY(index);
      if (point.x >= RAIL.x - 12 &&
          point.x <= railRightEdge(project.rails[index].capacity) + 12 &&
          point.y >= railY - 40 &&
          point.y <= railY + RAIL.height + 40) {
        return index;
      }
    }
    return null;
  }

  // Раскладывает все модули склейки по новым местам и проверяет КАЖДЫЙ из
  // них: выход за рейку, наезд на чужой модуль и наезд друг на друга.
  // delta считается по модулю, за который схватились, и применяется ко всем.
  function computeGroupPlacements(targetRailIndex, primaryDropSlot) {
    const primaryOrigin = dragState.memberOrigins?.get(dragState.moduleId);
    if (!primaryOrigin) return [];

    const railDelta = targetRailIndex - primaryOrigin.railIndex;
    const slotDelta = primaryDropSlot - primaryOrigin.slot;
    const groupIds = new Set(dragState.groupMemberIds || []);

    // Занятые слоты всех реек без текущих позиций самой группы: модули
    // склейки не должны мешать сами себе при пересчёте новых координат.
    const occupied = new Map();
    project.rails.forEach((rail) => occupied.set(rail.id, occupiedSlots(rail)));
    groupIds.forEach((id) => {
      const location = railOfModule(id);
      if (!location) return;
      const used = occupied.get(location.rail.id);
      if (!used) return;
      for (let offset = 0; offset < location.module.width; offset += 1) {
        used.delete(location.module.slot + offset);
      }
    });

    const ownSlots = new Map(); // railId -> Set слотов, уже занятых участниками группы
    const placements = [];
    dragState.groupMemberIds.forEach((id) => {
      const origin = dragState.memberOrigins.get(id);
      if (!origin) return;
      const railIndex = origin.railIndex + railDelta;
      const slot = origin.slot + slotDelta;
      const rail = project.rails[railIndex] || null;
      const inBounds = Boolean(rail) && Number.isInteger(slot) &&
        slot >= 0 && slot + origin.width <= rail.capacity;
      const used = rail ? (occupied.get(rail.id) || new Set()) : new Set();
      const own = rail ? (ownSlots.get(rail.id) || new Set()) : new Set();
      const free = inBounds &&
        rangeIsFree(used, slot, origin.width) &&
        rangeIsFree(own, slot, origin.width);

      placements.push({
        id,
        railId: rail ? rail.id : origin.railId,
        railIndex,
        slot,
        width: origin.width,
        valid: free,
        reason: free ? null : (inBounds ? 'collision' : 'overflow')
      });

      if (rail) {
        if (inBounds) {
          for (let offset = 0; offset < origin.width; offset += 1) own.add(slot + offset);
        }
        ownSlots.set(rail.id, own);
      }
    });
    return placements;
  }

  function updateNoteDragPosition(point) {
    if (!dragState || dragState.kind !== 'note') return;
    const note = noteById(dragState.noteId);
    if (!note) return;
    const position = clampNotePosition(
      point.x - dragState.grabOffsetX,
      point.y - dragState.grabOffsetY
    );
    note.x = position.x;
    note.y = position.y;
    scheduleCanvasRender();
  }

  function updateDragPosition(point) {
    if (!dragState) return;

    const railIndex = railIndexAtPoint(point);
    const overRail = railIndex !== null;
    let dropSlot = 0;
    let valid = false;
    let targetRailId = null;

    if (overRail) {
      const targetRail = project.rails[railIndex];
      targetRailId = targetRail.id;
      // Прилипаем к ближайшему целому слоту (делению рейки). Смещение захвата
      // сохраняет положение модуля под курсором относительно точки захвата.
      dropSlot = slotFromX(
        point.x,
        dragState.width,
        targetRail.capacity,
        dragState.grabOffsetPx
      );

      if (dragState.groupId && dragState.groupMemberIds?.length > 1) {
        dragState.groupPlacements = computeGroupPlacements(railIndex, dropSlot);
        valid = dragState.groupPlacements.length > 0 &&
          dragState.groupPlacements.every((placement) => placement.valid);
      } else {
        dragState.groupPlacements = [];
        valid = canPlaceModule(
          targetRail,
          dropSlot,
          dragState.width,
          dragState.kind === 'reorder' ? dragState.moduleId : null
        );
      }
    } else {
      dragState.groupPlacements = [];
    }

    const changed = dragState.overRail !== overRail ||
      dragState.dropSlot !== dropSlot ||
      dragState.valid !== valid ||
      dragState.targetRailId !== targetRailId ||
      Boolean(dragState.groupId);

    dragState.overRail = overRail;
    dragState.dropSlot = dropSlot;
    dragState.valid = valid;
    dragState.targetRailId = targetRailId;

    if (changed) scheduleCanvasRender();
  }

  function resetInteractionState() {
    gesture = null;
    dragState = null;
    document.body.classList.remove('is-dragging');
  }

  /* ------------------------ Selection box (рамка) ----------------------- */

  // Прямоугольник модуля в координатах схемы. Положение однозначно
  // определяется рейкой и слотом, поэтому hit-test не зависит от рендера
  // и работает одинаково при любом зуме/панораме.
  function moduleBounds(moduleId) {
    const location = railOfModule(moduleId);
    if (!location) return null;
    return {
      x: moduleSlotX(location.module.slot),
      y: railModuleY(location.index),
      width: location.module.width * MODULE_UNIT,
      height: MODULE_HEIGHT
    };
  }

  function rectsIntersect(first, second) {
    return first.x < second.x + second.width &&
      second.x < first.x + first.width &&
      first.y < second.y + second.height &&
      second.y < first.y + first.height;
  }

  function normalizedBox(first, second) {
    return {
      x: Math.min(first.x, second.x),
      y: Math.min(first.y, second.y),
      width: Math.abs(first.x - second.x),
      height: Math.abs(first.y - second.y)
    };
  }

  // Класс .selected навешивается на уже отрисованные элементы: так не
  // перерисовывается весь холст и сохраняются фокус/прокрутка. Призрак при
  // перетаскивании несёт тот же id, что и оригинал — пропускаем его.
  function updateSelectionClasses() {
    selectedModuleIds.forEach((id) => {
      if (!moduleById(id)) selectedModuleIds.delete(id);
    });
    if (!dom.moduleLayer) return;
    // Порты тоже несут data-module-id, но используются только корпуса.
    // Источник питания лежит в отдельной группе и никогда не выделяется.
    dom.moduleLayer.querySelectorAll('.module').forEach((element) => {
      if (element.classList.contains('module--ghost')) return;
      element.classList.toggle(
        'selected',
        selectedModuleIds.has(element.getAttribute('data-module-id'))
      );
    });
    // Доступность кнопок «Склеить/Разъединить» зависит от текущего выделения.
    updateActionState();
  }

  function clearSelection() {
    const hadModules = selectedModuleIds.size > 0;
    const hadNote = selectedNoteId !== null;
    if (!hadModules && !hadNote) return;
    selectedModuleIds.clear();
    selectedNoteId = null;
    if (hadModules) updateSelectionClasses();
    if (hadNote) scheduleCanvasRender();
  }

  // Обычный клик выбирает только модуль; Shift+клик переключает его
  // принадлежность текущему выделению.
  function toggleModuleSelection(moduleId, additive) {
    if (!moduleById(moduleId)) return;
    if (additive) {
      if (selectedModuleIds.has(moduleId)) selectedModuleIds.delete(moduleId);
      else selectedModuleIds.add(moduleId);
    } else {
      selectedModuleIds.clear();
      selectedModuleIds.add(moduleId);
    }
    selectedConnectionId = null;
    cancelWireSelection();
    updateSelectionClasses();
  }

  /* --------------------- Склейка и разъединение ------------------------ */

  // Склеить: все выделенные (рамкой или Shift+кликом) модули получают один
  // общий groupId. Один уникальный идентификатор на всю группу.
  function groupSelectedModules() {
    const modules = selectedModules();
    if (modules.length < 2) {
      showToast('Выделите хотя бы 2 модуля рамкой или Shift+Кликом.', 'error', 3600);
      return;
    }
    const groupId = makeId('grp');
    modules.forEach((module) => { module.groupId = groupId; });

    clearConnectionDraft();
    persistProject();
    commitHistory();
    renderAll();
    showToast(
      `Склеено модулей: ${modules.length}. Теперь они двигаются вместе · Ctrl+Shift+G — разъединить`,
      'success',
      3600
    );
  }

  // Разъединить: у всех выделенных модулей просто убираем groupId.
  function ungroupSelectedModules() {
    const modules = selectedModules().filter((module) => module.groupId);
    if (modules.length === 0) {
      showToast('Среди выделенных модулей нет склеенных.', 'error', 3200);
      return;
    }
    modules.forEach((module) => { delete module.groupId; });

    persistProject();
    commitHistory();
    renderAll();
    showToast(`Разъединено модулей: ${modules.length}`, 'success', 2600);
  }

  /* ---------------- Контекстное меню / буфер обмена ------------------- */

  // Иконки меню — только локальные строки, в HTML попадают как есть.
  const CONTEXT_ICONS = Object.freeze({
    delete: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 6h11M8 6V4.5h4V6m-6 0 .7 10h6.6L14 6M8.6 9v4.4M11.4 9v4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    duplicate: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="6.75" y="6.75" width="9.5" height="9.5" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M13.25 4.25H5.5a1.5 1.5 0 0 0-1.5 1.5v7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    group: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.4" y="6" width="6.7" height="8.4" rx="1.6" stroke="currentColor" stroke-width="1.5"/><rect x="10.9" y="6" width="6.7" height="8.4" rx="1.6" stroke="currentColor" stroke-width="1.5"/><path d="M9.1 8.3h1.8m-1.8 3.4h1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    ungroup: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.4" y="6" width="6.7" height="8.4" rx="1.6" stroke="currentColor" stroke-width="1.5"/><rect x="10.9" y="6" width="6.7" height="8.4" rx="1.6" stroke="currentColor" stroke-width="1.5"/><path d="m9.2 8.1 1.6 3.8m0-3.8-1.6 3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    edit: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M13.1 4.3a1.7 1.7 0 0 1 2.4 2.4l-7.6 7.6-3.2.8.8-3.2 7.6-7.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    paste: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4.5" y="5.75" width="11" height="10" rx="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 5.75V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.25M7.5 9.5h5M7.5 12.5h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    reset: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 9.3a6.5 6.5 0 1 1 1.6 5.2M3.5 14.5V10h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  });

  function closeContextMenu() {
    contextMenuState = null;
    if (dom.contextMenu) dom.contextMenu.hidden = true;
  }

  // Меню позиционируется в координатах окна (position: fixed). Если у курсора
  // не хватает места справа/снизу — раскрываем влево/вверх.
  function positionContextMenu(clientX, clientY) {
    if (!dom.contextMenu) return;
    dom.contextMenu.hidden = false;
    const width = dom.contextMenu.offsetWidth;
    const height = dom.contextMenu.offsetHeight;
    const margin = 8;
    const left = clientX + width + margin > window.innerWidth ? clientX - width : clientX;
    const top = clientY + height + margin > window.innerHeight ? clientY - height : clientY;
    dom.contextMenu.style.left = `${clamp(left, margin, Math.max(margin, window.innerWidth - width - margin))}px`;
    dom.contextMenu.style.top = `${clamp(top, margin, Math.max(margin, window.innerHeight - height - margin))}px`;
  }

  function renderContextMenu(items, headText) {
    if (!dom.contextMenuItems) return;
    if (dom.contextMenuHead) dom.contextMenuHead.textContent = headText || '';
    dom.contextMenuItems.replaceChildren();

    items.forEach((item) => {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.className = 'context-menu-separator';
        separator.setAttribute('role', 'separator');
        dom.contextMenuItems.appendChild(separator);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `context-menu-item${item.danger ? ' is-danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(item.disabled);
      button.innerHTML = `${item.icon || ''}<span class="context-menu-item-label">${escapeHtml(item.label)}</span>${item.hint ? `<span class="context-menu-item-hint">${escapeHtml(item.hint)}</span>` : ''}`;
      button.addEventListener('click', () => {
        closeContextMenu();
        item.action?.();
      });
      dom.contextMenuItems.appendChild(button);
    });
  }

  // Псевдо-якорь для поля подписи: при открытии из ПКМ поле появляется прямо
  // под курсором, а не у габарита всего провода.
  function cursorAnchor(clientX, clientY) {
    return {
      getBoundingClientRect: () => ({
        left: clientX, top: clientY, right: clientX, bottom: clientY,
        x: clientX, y: clientY, width: 0, height: 0
      })
    };
  }

  // Рейка под курсором: внутри пластины — точное попадание, вне — ближайшая.
  function railAtPoint(point) {
    let nearest = project.rails[0] || null;
    let bestDistance = Infinity;
    project.rails.forEach((rail, index) => {
      const top = railPlateY(index);
      const distance = point.y >= top && point.y <= top + RAIL.height
        ? 0
        : Math.abs(point.y - (top + RAIL.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = rail;
      }
    });
    return nearest;
  }

  function copyModuleData(module) {
    const data = { ...module };
    if (module.ports && typeof module.ports === 'object') data.ports = { ...module.ports };
    return data;
  }

  // Копия данных модулей плюс новые id для склеек, чтобы дубликаты оставались
  // сгруппированными между собой, но не влияли на исходную группу.
  function makeModuleClipboard(modules) {
    const items = [];
    const groupMap = new Map();
    modules.filter(Boolean).forEach((module) => {
      const location = railOfModule(module.id);
      const item = { data: copyModuleData(module), railId: location?.rail.id || null };
      if (safeGroupId(module.groupId)) {
        if (!groupMap.has(module.groupId)) groupMap.set(module.groupId, makeId('grp'));
        item.groupId = groupMap.get(module.groupId);
      }
      items.push(item);
    });
    return { items, groupMap };
  }

  function copyModulesToClipboard() {
    let modules = selectedModules();
    if (modules.length === 0 && lastContextModuleId) {
      const module = moduleById(lastContextModuleId);
      if (module) modules = [module];
    }
    if (modules.length === 0) {
      showToast('Выделите модули, чтобы скопировать их (Ctrl+C).', 'error', 3200);
      return false;
    }
    moduleClipboard = makeModuleClipboard(modules);
    showToast(
      `Скопировано модулей: ${modules.length}. Ctrl+V — вставить`,
      'success',
      2800
    );
    return true;
  }

  // Проверяем все целевые слоты заранее: либо вставляем всю пачку, либо ничего.
  function planPlacements(items, rail, baseSlot) {
    const used = new Set();
    rail.modules.forEach((module) => {
      for (let offset = 0; offset < module.width; offset += 1) {
        used.add(module.slot + offset);
      }
    });
    const sorted = items.slice().sort((first, second) => first.data.slot - second.data.slot);
    const minSlot = sorted.length ? sorted[0].data.slot : 0;
    const placements = [];
    for (const item of sorted) {
      const width = item.data.width;
      let slot = clamp(baseSlot + (item.data.slot - minSlot), 0, Math.max(0, rail.capacity - width));
      if (!rangeIsFree(used, slot, width)) slot = firstFreeSlot(used, width, rail.capacity);
      if (slot === null || !rangeIsFree(used, slot, width)) return null;
      for (let offset = 0; offset < width; offset += 1) used.add(slot + offset);
      placements.push({ item, slot });
    }
    return placements;
  }

  function moduleTagPrefix(module) {
    const fromTag = String(module?.tag || '').match(/^[A-Za-zА-Яа-я]{1,4}/u);
    return fromTag
      ? fromTag[0]
      : (LIBRARY_BY_ID.get(module?.libraryId)?.tagPrefix || 'M');
  }

  // Общая вставка копий. preferredRail/baseSlot задают точку смещения; если на
  // ней нет места — пробуем остальные рейки по очереди.
  function insertClonedModules(payload, options = {}) {
    const items = payload?.items || [];
    if (items.length === 0 || project.rails.length === 0) return [];

    const preferredRail = options.rail || railAtPoint(options.point) || project.rails[0];
    const baseSlot = Number.isFinite(options.baseSlot) ? options.baseSlot : 0;
    let targetRail = null;
    let placements = null;
    for (const rail of [preferredRail, ...project.rails.filter((item) => item !== preferredRail)]) {
      const plan = planPlacements(items, rail, rail === preferredRail ? baseSlot : 0);
      if (plan) {
        targetRail = rail;
        placements = plan;
        break;
      }
    }
    if (!placements) {
      reportNoRoom(preferredRail, items.reduce((total, item) => total + item.data.width, 0));
      return [];
    }

    const created = [];
    const reservedTags = new Set();
    placements.forEach(({ item, slot }) => {
      const module = copyModuleData(item.data);
      module.id = makeId('mod');
      module.slot = slot;
      if (item.groupId) module.groupId = item.groupId;
      else delete module.groupId;
      module.tag = generateTag(moduleTagPrefix(item.data), allModules(), reservedTags);
      reservedTags.add(module.tag.toUpperCase());
      targetRail.modules.push(module);
      created.push(module);
    });

    clearConnectionDraft();
    normalizeSlots();
    persistProject();
    commitHistory();
    renderAll();
    // Новые модули остаются выделенными — с ними можно сразу работать дальше.
    selectedModuleIds.clear();
    created.forEach((module) => selectedModuleIds.add(module.id));
    updateSelectionClasses();
    return created;
  }

  function defaultPastePoint() {
    const rect = dom.canvas.getBoundingClientRect();
    return svgPointFromClient(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function pasteModulesAt(point) {
    if (!moduleClipboard || moduleClipboard.items.length === 0) {
      showToast('Буфер обмена пуст — сначала скопируйте модули (Ctrl+C).', 'error', 3200);
      return false;
    }
    const target = point || lastPointerSvgPoint || defaultPastePoint();
    const items = moduleClipboard.items;
    const minSlot = Math.min(...items.map((item) => item.data.slot));
    const baseSlot = Math.round((target.x - RAIL.startX) / MODULE_UNIT) - minSlot;
    const created = insertClonedModules(moduleClipboard, {
      rail: railAtPoint(target),
      baseSlot
    });
    if (created.length) {
      showToast(`Вставлено модулей: ${created.length}`, 'success', 2600);
    }
    return created.length > 0;
  }

  // Дублирование «со смещением»: копия встаёт на один свободный слот правее
  // исходного модуля (или правого края всей выделенной группы).
  function duplicateModulesAtOffset(moduleId) {
    const clicked = moduleById(moduleId);
    if (!clicked) return;
    const modules = (selectedModuleIds.has(moduleId) && selectedModuleIds.size > 1)
      ? selectedModules()
      : [clicked];
    const location = railOfModule(modules[0].id);
    if (!location) return;
    const rightEdge = modules.reduce((max, module) => Math.max(max, module.slot + module.width), 0);
    const created = insertClonedModules(makeModuleClipboard(modules), {
      rail: location.rail,
      baseSlot: rightEdge + 1
    });
    if (created.length) {
      showToast(`Дублировано модулей: ${created.length} · со смещением`, 'success', 2600);
    }
  }

  function onContextMenu(event) {
    // Системное меню оставляем в полях ввода, диалогах и служебных панелях.
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"], dialog, .context-menu, .layers-panel, .wire-type-popover')) return;
    closeContextMenu();
    if (editing) commitInlineEdit();
    event.preventDefault();

    // Правый клик по холсту в режиме заметки — отказ: заметку не ставим,
    // режим сбрасываем (левый клик всё ещё поставил бы стикер).
    if (notePlacing) {
      setNotePlacing(false);
      return;
    }

    const svgPoint = getSVGCoords(event);
    lastPointerSvgPoint = svgPoint;
    const clientX = event.clientX;
    const clientY = event.clientY;

    // ПКМ по стикеру: редактирование текста и удаление.
    const noteElement = event.target.closest?.('[data-note-id]');
    const noteId = noteElement?.getAttribute('data-note-id');
    if (noteId && noteById(noteId) && !event.target.closest?.('[data-delete-note]')) {
      selectedNoteId = noteId;
      contextMenuState = { kind: 'note', id: noteId, svgPoint };
      renderContextMenu([
        {
          label: 'Изменить текст',
          icon: CONTEXT_ICONS.edit,
          action: () => {
            const anchor = dom.notesLayer?.querySelector(`[data-note-id="${noteId}"]`) || noteElement;
            openInlineEditor('note', noteId, anchor);
          }
        },
        { label: 'Удалить', hint: 'Del', danger: true, icon: CONTEXT_ICONS.delete,
          action: () => removeNote(noteId) }
      ], 'Заметка');
      positionContextMenu(clientX, clientY);
      return;
    }

    const moduleElement = event.target.closest?.('[data-module-id]');
    const moduleId = moduleElement?.getAttribute('data-module-id');
    if (moduleId && moduleId !== POWER_SOURCE.id && moduleById(moduleId)) {
      // ПКМ по невыделенному модулю сначала выделяет его.
      if (!selectedModuleIds.has(moduleId)) toggleModuleSelection(moduleId, false);
      lastContextModuleId = moduleId;
      contextMenuState = { kind: 'module', id: moduleId, svgPoint };

      const count = selectedModuleIds.size;
      const hasGroups = selectedModules().some((module) => module.groupId);
      const items = [
        { label: 'Удалить', hint: 'Del', danger: true, icon: CONTEXT_ICONS.delete, action: () => deleteSelected() },
        { label: 'Дублировать', icon: CONTEXT_ICONS.duplicate, action: () => duplicateModulesAtOffset(moduleId) }
      ];
      if (count > 1) {
        items.push(hasGroups
          ? { label: 'Разъединить', hint: 'Ctrl+Shift+G', icon: CONTEXT_ICONS.ungroup, action: ungroupSelectedModules }
          : { label: 'Склеить', hint: 'Ctrl+G', icon: CONTEXT_ICONS.group, action: groupSelectedModules });
      }
      items.push({ separator: true });
      items.push({
        label: 'Изменить подпись',
        icon: CONTEXT_ICONS.edit,
        action: () => {
          const anchor = dom.moduleLayer.querySelector(`[data-module-id="${moduleId}"]`) || moduleElement;
          // Редактируем только пользовательскую подпись (description).
          // Заводское название (name) остаётся нетронутым — оно идёт в смету
          // и спецификацию и не должно меняться из контекстного меню.
          openInlineEditor('module', moduleId, anchor);
        }
      });
      renderContextMenu(items, count > 1 ? `Модулей выбрано: ${count}` : 'Модуль');
      positionContextMenu(clientX, clientY);
      return;
    }

    const wireElement = event.target.closest?.('[data-connection-id], [data-wire-id]');
    const connectionId = wireElement?.getAttribute('data-connection-id') ||
      wireElement?.getAttribute('data-wire-id');
    if (connectionId && project.connections.some((connection) => connection.id === connectionId)) {
      selectConnection(connectionId);
      contextMenuState = { kind: 'wire', id: connectionId, svgPoint };
      renderContextMenu([
        { label: 'Удалить', hint: 'Del', danger: true, icon: CONTEXT_ICONS.delete, action: () => removeConnection(connectionId) },
        {
          label: 'Изменить примечание',
          icon: CONTEXT_ICONS.edit,
          action: () => openInlineEditor('wire', connectionId, cursorAnchor(clientX, clientY))
        }
      ], 'Провод');
      positionContextMenu(clientX, clientY);
      return;
    }

    // Пустое место холста.
    contextMenuState = { kind: 'canvas', id: null, svgPoint };
    const items = [];
    if (moduleClipboard && moduleClipboard.items.length) {
      items.push({
        label: 'Вставить', hint: 'Ctrl+V', icon: CONTEXT_ICONS.paste,
        action: () => pasteModulesAt(svgPoint)
      });
    }
    items.push({ label: 'Сбросить вид', hint: 'Home', icon: CONTEXT_ICONS.reset, action: resetView });
    renderContextMenu(items, 'Холст');
    positionContextMenu(clientX, clientY);
  }

  function hideSelectionBox() {
    if (dom.selectionBox) dom.selectionBox.style.display = 'none';
  }

  function drawSelectionBox(box) {
    if (!dom.selectionBox) return;
    dom.selectionBox.setAttribute('x', viewNumber(box.x));
    dom.selectionBox.setAttribute('y', viewNumber(box.y));
    dom.selectionBox.setAttribute('width', viewNumber(box.width));
    dom.selectionBox.setAttribute('height', viewNumber(box.height));
    dom.selectionBox.style.display = '';
  }

  function cancelSelectionBox() {
    if (!selectionBoxState) return;
    selectionBoxState = null;
    hideSelectionBox();
  }

  // Рамка стартует только на фоне: не на модуле, проводе, порту, кнопке
  // и не при зажатом Пробеле/средней кнопке (панорамирование).
  function isSelectionBackground(target) {
    if (!(target instanceof Element)) return false;
    return !target.closest([
      '[data-module-id]', '[data-wire-id]', '[data-connection-id]', '[data-port-id]',
      '[data-note-id]', '[data-delete-note]',
      '[data-delete-module]', '[data-delete-wire]', '[data-delete-rail]',
      '[data-rail-capacity]', '[data-toggle-module]', '[data-toggle-source]',
      '.power-source', 'button', 'a', 'input', '[role="button"]', '[role="switch"]'
    ].join(', '));
  }

  function onSelectionMouseDown(event) {
    if (notePlacing) return; // режим заметки: рамка выделения не нужна
    if (event.button !== 0 || spaceHeld || panState || gesture || dragState) return;
    if (selectionBoxState || editing) return;
    if (!isSelectionBackground(event.target)) return;
    const start = getSVGCoords(event);
    if (!start || !Number.isFinite(start.x) || !Number.isFinite(start.y)) return;
    event.preventDefault();
    selectionBoxState = {
      startX: start.x,
      startY: start.y,
      endX: start.x,
      endY: start.y,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      shiftKey: event.shiftKey
    };
  }

  function onSelectionMouseMove(event) {
    if (!selectionBoxState) return;
    const distance = Math.hypot(
      event.clientX - selectionBoxState.clientX,
      event.clientY - selectionBoxState.clientY
    );
    if (!selectionBoxState.moved && distance < 4) return;
    const point = getSVGCoords(event);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    selectionBoxState.moved = true;
    selectionBoxState.endX = point.x;
    selectionBoxState.endY = point.y;
    drawSelectionBox(normalizedBox(
      { x: selectionBoxState.startX, y: selectionBoxState.startY },
      { x: selectionBoxState.endX, y: selectionBoxState.endY }
    ));
  }

  function onSelectionMouseUp(event) {
    if (!selectionBoxState) return;
    const state = selectionBoxState;
    selectionBoxState = null;
    hideSelectionBox();
    // Просто клик: рамку не показывали, выделение снимет onCanvasClick.
    if (!state.moved) return;

    const end = getSVGCoords(event) || { x: state.endX, y: state.endY };
    const box = normalizedBox({ x: state.startX, y: state.startY }, end);
    const additive = state.shiftKey || event.shiftKey;

    const hits = new Set();
    allModules().forEach((module) => {
      const bounds = moduleBounds(module.id);
      if (bounds && rectsIntersect(box, bounds)) hits.add(module.id);
    });
    if (!additive) selectedModuleIds.clear();
    hits.forEach((id) => selectedModuleIds.add(id));
    selectedConnectionId = null;
    cancelWireSelection();
    updateSelectionClasses();

    // Клик сразу после mouseup не должен сбросить только что сделанное выделение.
    suppressCanvasClickUntil = performance.now() + 250;
  }

  function activateDrag(event) {
    if (!gesture) return;

    // Стикер тащится свободно по холсту — без привязки к рейке и слотам.
    if (gesture.kind === 'note') {
      const note = noteById(gesture.noteId);
      if (!note) {
        resetInteractionState();
        return;
      }
      clearConnectionDraft();
      dragState = {
        kind: 'note',
        pointerId: event.pointerId,
        noteId: note.id,
        originX: note.x,
        originY: note.y,
        grabOffsetX: gesture.grabOffsetX || 0,
        grabOffsetY: gesture.grabOffsetY || 0
      };
      document.body.classList.add('is-dragging');
      return;
    }

    if (gesture.kind === 'library') {
      const libraryItem = LIBRARY_BY_ID.get(gesture.libraryId);
      if (!libraryItem) {
        resetInteractionState();
        return;
      }
      clearConnectionDraft();
      dragState = {
        kind: 'library',
        pointerId: event.pointerId,
        libraryId: libraryItem.id,
        width: libraryItem.width,
        ghostTag: generateTag(libraryItem.tagPrefix, allModules()),
        overRail: false,
        targetRailId: null,
        dropSlot: 0,
        grabOffsetPx: 0,
        valid: false
      };
    } else {
      const sourceModule = railOfModule(gesture.moduleId)?.module || null;
      if (!sourceModule) {
        resetInteractionState();
        return;
      }
      clearConnectionDraft();
      // Смещение берём от точки нажатия (а не от первого события move),
      // чтобы модуль оставался под курсором в том же месте, за которое взят.
      const grabX = Number.isFinite(gesture.startSvgX)
        ? gesture.startSvgX
        : (svgPointFromEvent(event)?.x ?? moduleSlotX(sourceModule.slot));
      dragState = {
        kind: 'reorder',
        pointerId: event.pointerId,
        moduleId: sourceModule.id,
        width: sourceModule.width,
        overRail: false,
        targetRailId: null,
        dropSlot: sourceModule.slot,
        grabOffsetPx: grabX - moduleSlotX(sourceModule.slot),
        valid: false
      };

      // Склейка: тащим ВСЕ модули с тем же groupId. За точку отсчёта берём
      // модуль, за который схватились: его смещение (railDelta/slotDelta)
      // одинаково применяется ко всем остальным участникам группы.
      const groupId = safeGroupId(sourceModule.groupId);
      const members = modulesOfGroup(groupId);
      if (members.length > 1) {
        const origins = new Map();
        members.forEach((member) => {
          const location = railOfModule(member.id);
          if (!location) return;
          origins.set(member.id, {
            railId: location.rail.id,
            railIndex: location.index,
            slot: member.slot,
            width: member.width
          });
        });
        const primary = railOfModule(sourceModule.id);
        if (primary && origins.has(sourceModule.id)) {
          dragState.groupId = groupId;
          dragState.groupMemberIds = members.map((member) => member.id);
          dragState.memberOrigins = origins;
          dragState.primaryRailIndex = primary.index;
          dragState.primarySlot = sourceModule.slot;
          dragState.groupPlacements = [];
        }
      }
    }

    document.body.classList.add('is-dragging');
  }

  function reportNoRoom(rail, width) {
    flashCanvasError();
    const free = rail.capacity - usedWidth(rail);
    showToast(
      `Нет свободного места: нужно ${width} P, свободно ${free} P.`,
      'error',
      4000
    );
  }

  function placeLibraryModule(libraryId, slot, options = {}) {
    const libraryItem = LIBRARY_BY_ID.get(libraryId);
    if (!libraryItem) return false;

    const rail = railById(options.railId) || railWithRoom(libraryItem.width);
    if (!rail) return false;

    // При добавлении кликом (без перетаскивания) ищем первое свободное место
    // в конце рейки; если там нет места — первый подходящий зазор.
    const targetSlot = Number.isFinite(slot)
      ? clampSlot(rail, slot, libraryItem.width)
      : findFreeSlotAtEnd(rail, libraryItem.width);
    if (targetSlot === null || !canPlaceModule(rail, targetSlot, libraryItem.width)) {
      reportNoRoom(rail, libraryItem.width);
      return false;
    }

    const module = createModuleFromLibrary(libraryItem, options.tag);
    module.slot = targetSlot;
    rail.modules.push(module);
    normalizeSlots();
    persistProject();
    commitHistory();
    renderAll();

    if (options.toast !== false) {
      showToast(`Добавлен ${libraryItem.name} · слот ${targetSlot + 1}`, 'success', 2200);
    }
    return true;
  }

  function moveModule(moduleId, targetRailId, targetSlot) {
    const source = railOfModule(moduleId);
    const targetRail = railById(targetRailId);
    if (!source || !targetRail) return false;

    const sourceRail = source.rail;
    const sourceIndex = sourceRail.modules.findIndex((module) => module.id === moduleId);
    if (sourceIndex < 0) return false;
    const module = sourceRail.modules[sourceIndex];

    const newSlot = clampSlot(targetRail, targetSlot, module.width);
    if (sourceRail.id === targetRail.id && module.slot === newSlot) {
      renderAll();
      return false;
    }
    // Целевые слоты должны быть свободны — иначе перенос отменяется.
    if (!canPlaceModule(targetRail, newSlot, module.width, moduleId)) {
      flashCanvasError();
      showToast('Место занято — модуль остался на прежнем месте.', 'error', 3600);
      renderAll();
      return false;
    }

    const before = project.rails
      .map((rail) => rail.modules.map((item) => `${item.id}@${item.slot}`).join(',')).join('|');
    module.slot = newSlot;
    if (sourceRail.id !== targetRail.id) {
      sourceRail.modules.splice(sourceIndex, 1);
      targetRail.modules.push(module);
    }
    // Привязка проводов к рейке обновляется вместе с модулем.
    project.connections.forEach((connection) => {
      if (connection.fromModuleId === moduleId) connection.fromRailId = targetRail.id;
      if (connection.toModuleId === moduleId) connection.toRailId = targetRail.id;
    });
    const after = project.rails
      .map((rail) => rail.modules.map((item) => `${item.id}@${item.slot}`).join(',')).join('|');

    if (before === after) {
      renderAll();
      return false;
    }

    persistProject();
    commitHistory();
    renderAll();
    return true;
  }

  // Атомарный перенос всей склейки: либо встают ВСЕ модули, либо ни один.
  // Валидация уже выполнена в computeGroupPlacements(); здесь только применяем
  // результат, чтобы не оставить группу в половинчатом состоянии.
  function moveModuleGroup(finished) {
    const placements = finished.groupPlacements || [];
    if (!finished.valid || placements.length === 0) {
      flashCanvasError();
      showToast(
        'Группа не помещается: место занято или выходит за рейку — перенос отменён.',
        'error',
        4200
      );
      renderAll();
      return false;
    }

    const changed = placements.some((placement) => {
      const location = railOfModule(placement.id);
      return !location ||
        location.rail.id !== placement.railId ||
        location.module.slot !== placement.slot;
    });
    if (!changed) {
      renderAll();
      return false;
    }

    // Сначала отсоединяем все модули, затем раскладываем по новым рейкам:
    // так перенос между рейками не ломает индексы и не создаёт коллизий.
    const detached = new Map();
    placements.forEach((placement) => {
      const location = railOfModule(placement.id);
      if (!location) return;
      detached.set(placement.id, location.module);
      location.rail.modules = location.rail.modules.filter(
        (module) => module.id !== placement.id
      );
    });
    placements.forEach((placement) => {
      const module = detached.get(placement.id);
      if (!module) return;
      module.slot = placement.slot;
      const rail = railById(placement.railId);
      if (rail) rail.modules.push(module);
      project.connections.forEach((connection) => {
        if (connection.fromModuleId === placement.id) connection.fromRailId = placement.railId;
        if (connection.toModuleId === placement.id) connection.toRailId = placement.railId;
      });
    });

    persistProject();
    commitHistory();
    renderAll();
    showToast(`Группа перемещена: ${placements.length} модулей`, 'success', 2400);
    return true;
  }

  // Изменение длины (вместимости) рейки. Укорочение блокируется, если
  // правый край самого «дальнего» модуля вышел бы за новую вместимость —
  // иначе модули «выпали» бы за край рейки.
  function changeRailCapacity(railId, direction) {
    const rail = railById(railId);
    if (!rail) return;

    const step = direction > 0 ? RAIL_CAPACITY_STEP : -RAIL_CAPACITY_STEP;
    const next = rail.capacity + step;

    if (next < MIN_RAIL_CAPACITY) {
      showToast(`Минимальная длина рейки — ${MIN_RAIL_CAPACITY} P.`, 'error', 3200);
      return;
    }
    if (next > MAX_RAIL_CAPACITY) {
      showToast(`Максимальная длина рейки — ${MAX_RAIL_CAPACITY} P.`, 'error', 3200);
      return;
    }

    if (next < rail.capacity) {
      const maxEnd = rail.modules.reduce(
        (max, module) => Math.max(max, module.slot + module.width), 0
      );
      if (maxEnd > next) {
        flashCanvasError();
        showToast(
          'Ошибка! На рейке есть модули за пределами новой длины. Удалите или переместите их, чтобы укоротить рейку.',
          'error',
          5000
        );
        renderAll();
        return;
      }
    }

    rail.capacity = next;
    clearConnectionDraft();
    persistProject();
    commitHistory();
    renderAll();
  }

  function addRail() {
    if (project.rails.length >= MAX_RAILS) {
      showToast(`Можно добавить не более ${MAX_RAILS} реек.`, 'error', 3200);
      return;
    }
    project.rails.push(createRail());
    clearConnectionDraft();
    persistProject();
    commitHistory();
    renderAll();
    showToast('Добавлена новая рейка', 'success', 2200);
  }

  function removeRail(railId) {
    const index = railIndexOf(railId);
    if (index < 0) return;
    const rail = project.rails[index];

    if (rail.modules.length > 0) {
      flashCanvasError();
      showToast('Сначала удалите модули с рейки.', 'error', 3200);
      return;
    }
    if (project.rails.length <= 1) {
      showToast('Должна оставаться хотя бы одна рейка.', 'error', 3200);
      return;
    }

    project.rails.splice(index, 1);
    clearConnectionDraft();
    persistProject();
    commitHistory();
    renderAll();
    showToast(`Рейка ${index + 1} удалена`, 'success', 2200);
  }

  function finishDrag() {
    const finished = dragState;
    if (!finished) {
      resetInteractionState();
      renderAll();
      return;
    }

    resetInteractionState();
    suppressCanvasClickUntil = performance.now() + 350;

    if (finished.kind === 'note') {
      const note = noteById(finished.noteId);
      if (note && (note.x !== finished.originX || note.y !== finished.originY)) {
        persistProject();
        commitHistory();
      }
      renderAll();
      return;
    }

    if (!finished.overRail || !finished.targetRailId) {
      renderAll();
      return;
    }

    const targetRail = railById(finished.targetRailId);
    if (!targetRail) {
      renderAll();
      return;
    }

    if (!finished.valid) {
      flashCanvasError();
      showToast('Место занято или выходит за рейку — перенос отменён.', 'error', 3600);
      renderAll();
      return;
    }

    if (finished.kind === 'library') {
      placeLibraryModule(finished.libraryId, finished.dropSlot, {
        railId: finished.targetRailId,
        tag: finished.ghostTag
      });
      return;
    }

    if (finished.groupId && finished.groupMemberIds?.length > 1) {
      moveModuleGroup(finished);
      return;
    }

    moveModule(finished.moduleId, finished.targetRailId, finished.dropSlot);
  }

  function cancelActiveInteraction() {
    if (!dragState && !gesture) return;
    if (dragState?.kind === 'note') {
      const note = noteById(dragState.noteId);
      if (note) {
        note.x = dragState.originX;
        note.y = dragState.originY;
      }
    }
    resetInteractionState();
    suppressCanvasClickUntil = performance.now() + 250;
    renderAll();
  }

  function onLibraryPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (gesture || dragState) return;

    const card = event.target.closest('.component-card');
    if (!card) return;

    const libraryItem = LIBRARY_BY_ID.get(card.dataset.libraryId);
    if (!libraryItem) return;

    event.preventDefault();
    card.focus({ preventScroll: true });
    gesture = {
      kind: 'library',
      libraryId: libraryItem.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
  }

  function onLibraryClick(event) {
    // Pointer/touch taps are handled on pointerup. A click with detail === 0
    // comes from keyboard activation (Enter/Space), so support it separately.
    if (event.detail !== 0) return;
    const card = event.target.closest('.component-card');
    if (!card) return;
    const libraryItem = LIBRARY_BY_ID.get(card.dataset.libraryId);
    if (!libraryItem) return;
    const rail = railWithRoom(libraryItem.width);
    if (rail) placeLibraryModule(libraryItem.id, null, { railId: rail.id });
  }

  function onCanvasPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (gesture || dragState) return;
    // В режиме добавления заметки жесты перетаскивания/выделения не нужны.
    if (notePlacing) return;

    if (event.target.closest('[data-delete-module], [data-delete-wire], [data-delete-rail], [data-delete-note], [data-rail-capacity], [data-port-id], [data-connection-id], [data-toggle-module], [data-toggle-source]')) {
      return;
    }

    const noteElement = event.target.closest('[data-note-id]');
    if (noteElement) {
      const note = noteById(noteElement.getAttribute('data-note-id'));
      if (!note) return;
      event.preventDefault();
      noteElement.focus?.({ preventScroll: true });
      const startSvg = getSVGCoords(event);
      gesture = {
        kind: 'note',
        noteId: note.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        // Смещение захвата сохраняет положение стикера под курсором при тяге.
        grabOffsetX: startSvg ? startSvg.x - note.x : 0,
        grabOffsetY: startSvg ? startSvg.y - note.y : 0
      };
      return;
    }

    const moduleElement = event.target.closest('[data-module-id]');
    if (!moduleElement) return;

    const moduleId = moduleElement.getAttribute('data-module-id');
    if (!railOfModule(moduleId)) return;

    event.preventDefault();
    if (typeof moduleElement.focus === 'function') {
      moduleElement.focus({ preventScroll: true });
    }

    const startSvg = getSVGCoords(event);
    gesture = {
      kind: 'reorder',
      moduleId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // Точка захвата в координатах схемы — нужна, чтобы «призрак» не
      // смещался относительно курсора при прилипании к слотам.
      startSvgX: startSvg ? startSvg.x : null
    };
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    if (!dragState) {
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
      if (distance < 6) return;
      activateDrag(event);
      if (!dragState) return;
    }

    const point = svgPointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    if (dragState.kind === 'note') updateNoteDragPosition(point);
    else updateDragPosition(point);
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    if (dragState) {
      const point = svgPointFromEvent(event);
      if (point) {
        if (dragState.kind === 'note') updateNoteDragPosition(point);
        else updateDragPosition(point);
      }
      finishDrag();
      return;
    }

    const finishedGesture = gesture;
    resetInteractionState();

    if (finishedGesture.kind === 'library') {
      const libraryItem = LIBRARY_BY_ID.get(finishedGesture.libraryId);
      const rail = libraryItem ? railWithRoom(libraryItem.width) : project.rails[0];
      if (rail) placeLibraryModule(finishedGesture.libraryId, null, { railId: rail.id });
      return;
    }

    // Клик по модулю сам по себе ничего не делает: провода создаются только через порты.
  }

  function onPointerCancel(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    cancelActiveInteraction();
  }

  function onWindowBlur() {
    endPan();
    cancelSelectionBox();
    spaceHeld = false;
    dom.svgWrap.classList.remove('is-space-ready');
    if (gesture || dragState) cancelActiveInteraction();
  }

  /* --------------------------- Connections ---------------------------- */

  function clearConnectionDraft() {
    activePort = null;
    pendingWire = null;
    if (dom.portTooltip) dom.portTooltip.hidden = true;
    if (dom.wireTypePopover) dom.wireTypePopover.hidden = true;
  }

  function onPortClick(portElement) {
    const side = portElement.dataset.side;
    const index = Number(portElement.dataset.index);
    const moduleId = portElement.dataset.moduleId;
    if (!isPortSide(side) || !Number.isInteger(index)) return;
    const ref = { moduleId, side, index };

    if (!activePort) {
      activePort = ref;
      selectedConnectionId = null;
      renderAll();
      return;
    }

    // Повторный клик по активному порту отменяет выбор.
    if (samePort(activePort, ref)) {
      clearConnectionDraft();
      renderAll();
      return;
    }

    if (connectionExists(activePort, ref)) {
      clearConnectionDraft();
      renderAll();
      showToast('Такое соединение уже есть.', 'error', 2800);
      return;
    }

    // Строгая фазировка: занятый порт и несовместимые фазы блокируются.
    // Проверяем до «одного модуля», чтобы L1 + N всегда давали ошибку фазы.
    const validation = validatePortPair(activePort, ref);
    if (!validation.ok) {
      flashCanvasError();
      showToast(validation.message, 'error', 3400);
      return;
    }

    if (moduleId === activePort.moduleId) {
      flashCanvasError();
      showToast('Нельзя соединить порты одного модуля.', 'error', 2800);
      return;
    }

    pendingWire = ref;
    renderAll(); // превью провода + поповер выбора типа
  }

  function createConnection(type) {
    if (!activePort || !pendingWire || !WIRE_TYPES[type]) return;

    // Кнопки несовместимых типов заблокированы в поповере, но проверяем
    // ещё и здесь: фаза не должна измениться между выбором порта и кликом.
    const forced = draftWireType();
    if (forced && type !== forced) {
      flashCanvasError();
      showToast(`Ошибка фазировки! Для этого порта нужен провод ${forced}.`, 'error', 3400);
      return;
    }
    const validation = validatePortPair(activePort, pendingWire);
    if (!validation.ok) {
      flashCanvasError();
      showToast(validation.message, 'error', 3400);
      return;
    }

    const connection = {
      id: makeId('conn'),
      fromModuleId: activePort.moduleId,
      fromPortSide: activePort.side,
      fromPortIndex: activePort.index,
      fromRailId: railOfModule(activePort.moduleId)?.rail.id || null,
      toModuleId: pendingWire.moduleId,
      toPortSide: pendingWire.side,
      toPortIndex: pendingWire.index,
      toRailId: railOfModule(pendingWire.moduleId)?.rail.id || null,
      type,
      color: WIRE_TYPES[type].color,
      label: ''
    };

    project.connections.push(connection);
    clearConnectionDraft();
    selectedConnectionId = null;
    persistProject();
    commitHistory();
    renderAll();
    showToast(`Провод ${type} · ${connectionLabel(connection)} создан`, 'success', 2500);
  }

  function onWireTypeOptionClick(event) {
    const button = event.target.closest('[data-wire-type-option]');
    if (!button || button.disabled || !pendingWire) return;
    createConnection(button.dataset.wireTypeOption);
  }

  function onDocumentPointerDown(event) {
    // Любой клик вне меню закрывает его (в том числе по кнопке ПКМ — перед
    // открытием нового меню в onContextMenu).
    if (!event.target.closest?.('.context-menu')) closeContextMenu();

    // Отказ от режима «Добавить заметку»: клик вне холста отменяет его, заметка
    // не создаётся. Клик по самой кнопке не трогаем — её обработчик сам
    // переключит режим (включённый → выключенный). Клик по холсту тоже не
    // трогаем: там заметку поставит onCanvasClick.
    if (notePlacing) {
      const onToggleButton = dom.addNoteBtn?.contains(event.target);
      const onCanvas = event.target.closest?.('#panel-canvas');
      if (!onToggleButton && !onCanvas) setNotePlacing(false);
    }

    // Средняя кнопка — это панорамирование, а не выбор порта: не сбрасываем
    // подготовленный провод и не меняем состояние схемы.
    if (event.pointerType === 'mouse' && event.button === 1) return;
    if (!pendingWire) return;
    if (dom.wireTypePopover.contains(event.target)) return;
    if (event.target.closest?.('[data-port-id]')) return;
    // Клик вне поповера отменяет выбор второго порта, но оставляет первый активным.
    pendingWire = null;
    renderAll();
  }

  function selectConnection(connectionId) {
    if (!project.connections.some((connection) => connection.id === connectionId)) return;
    clearSelection();
    selectedConnectionId = connectionId;
    renderAll();
  }

  // Выделение провода откладывается, чтобы кнопка × не появлялась между
  // двумя кликами двойного щелчка и не перехватывала второй клик.
  function cancelWireSelection() {
    if (wireSelectTimer === null) return;
    clearTimeout(wireSelectTimer);
    wireSelectTimer = null;
  }

  function scheduleWireSelection(connectionId) {
    cancelWireSelection();
    wireSelectTimer = setTimeout(() => {
      wireSelectTimer = null;
      selectConnection(connectionId);
    }, 280);
  }

  function removeConnection(connectionId) {
    const connection = project.connections.find((item) => item.id === connectionId);
    if (!connection) return;

    const label = `${connectionPortLabel(connection, 'from')} — ${connectionPortLabel(connection, 'to')}`;

    project.connections = project.connections.filter((item) => item.id !== connectionId);
    if (selectedConnectionId === connectionId) selectedConnectionId = null;
    persistProject();
    commitHistory();
    renderAll();
    showToast(`Связь ${label} удалена`, 'success', 2400);
  }

  function removeModule(moduleId) {
    const location = railOfModule(moduleId);
    if (!location) return;
    const module = location.module;

    const relatedConnections = project.connections.filter((connection) => {
      return connection.fromModuleId === moduleId || connection.toModuleId === moduleId;
    }).length;

    location.rail.modules = location.rail.modules.filter((item) => item.id !== moduleId);
    // Удалённый модуль разрывает склейку: остальные участники становятся
    // обычными модулями (удаляется только тот, на котором нажат крестик).
    dissolveGroupsOf([module]);
    project.connections = project.connections.filter((connection) => {
      return connection.fromModuleId !== moduleId && connection.toModuleId !== moduleId;
    });
    if (activePort?.moduleId === moduleId || pendingWire?.moduleId === moduleId) {
      clearConnectionDraft();
    }
    selectedConnectionId = null;
    normalizeSlots();
    persistProject();
    commitHistory();
    renderAll();

    if (relatedConnections > 0) {
      showToast(
        `Модуль ${module.tag} и ${relatedConnections} ${plural(relatedConnections, ['связь', 'связи', 'связей'])} удалены`,
        'success',
        3000
      );
    } else {
      showToast(`Модуль ${module.tag} удалён`, 'success', 2300);
    }
  }

  // Групповое удаление: все выделенные модули и все провода, к ним
  // подключённые. Одна запись в истории и одно сохранение на всю операцию.
  function deleteSelectedModules() {
    if (selectedModuleIds.size === 0) return;
    const ids = new Set(selectedModuleIds);
    const modules = allModules().filter((module) => ids.has(module.id));
    selectedModuleIds.clear();
    if (modules.length === 0) {
      updateSelectionClasses();
      return;
    }

    const removedConnections = project.connections.filter((connection) =>
      ids.has(connection.fromModuleId) || ids.has(connection.toModuleId)
    );
    const removedConnectionIds = new Set(removedConnections.map((connection) => connection.id));

    project.rails.forEach((rail) => {
      rail.modules = rail.modules.filter((module) => !ids.has(module.id));
    });
    // Как и при удалении через «×»: удаляются только выбранные модули,
    // а оставшиеся участники их склеек больше не связаны.
    dissolveGroupsOf(modules);
    project.connections = project.connections.filter(
      (connection) => !removedConnectionIds.has(connection.id)
    );

    if ((activePort && ids.has(activePort.moduleId)) ||
        (pendingWire && ids.has(pendingWire.moduleId))) {
      clearConnectionDraft();
    }
    selectedConnectionId = null;
    cancelWireSelection();
    normalizeSlots();
    persistProject();
    commitHistory();
    renderAll();

    const parts = [`Модулей удалено: ${modules.length}`];
    if (removedConnections.length) {
      parts.push(`проводов удалено: ${removedConnections.length}`);
    }
    showToast(parts.join(', '), 'success', 2800);
  }

  function deleteSelected() {
    if (selectedModuleIds.size) deleteSelectedModules();
    else if (selectedConnectionId) removeConnection(selectedConnectionId);
    else if (selectedNoteId) removeNote(selectedNoteId);
  }

  function toggleModule(moduleId) {
    const location = railOfModule(moduleId);
    if (!location || !moduleHasSwitch(location.module)) return;

    location.module.isOn = location.module.isOn === false;
    persistProject();
    commitHistory();
    renderAll();

    // После перерисовки возвращаем фокус на тот же рычажок — важно для клавиатуры.
    const nextSwitch = dom.moduleLayer.querySelector(`[data-toggle-module="${moduleId}"]`);
    if (nextSwitch && typeof nextSwitch.focus === 'function') {
      nextSwitch.focus({ preventScroll: true });
    }
  }

  function toggleSource() {
    if (!project.source) project.source = { isOn: true };
    project.source.isOn = project.source.isOn === false;
    persistProject();
    commitHistory();
    renderAll();

    const nextSwitch = dom.powerSourceLayer?.querySelector('[data-toggle-source]');
    if (nextSwitch && typeof nextSwitch.focus === 'function') {
      nextSwitch.focus({ preventScroll: true });
    }
  }

  function syncSimulationToggle() {
    const enabled = isSimulationOn();
    if (dom.simulationToggle) dom.simulationToggle.checked = enabled;
    if (dom.simulationState) dom.simulationState.textContent = enabled ? 'Вкл' : 'Выкл';
  }

  function onSimulationToggleChange() {
    project.simulation = Boolean(dom.simulationToggle?.checked);
    persistProject();
    syncSimulationToggle();
    renderAll();
  }

  function syncParamsToggle() {
    const enabled = isShowingParams();
    if (dom.paramsToggle) dom.paramsToggle.checked = enabled;
    if (dom.paramsState) dom.paramsState.textContent = enabled ? 'Вкл' : 'Выкл';
  }

  function onParamsToggleChange() {
    project.showParams = Boolean(dom.paramsToggle?.checked);
    persistProject();
    syncParamsToggle();
    renderAll();
  }

  function cancelModuleToggle() {
    if (moduleToggleTimer === null) return;
    clearTimeout(moduleToggleTimer);
    moduleToggleTimer = null;
  }

  function onModuleToggleClick(event) {
    const toggle = event.target.closest?.('[data-toggle-module]');
    if (!toggle) return;
    // Клик по рычажку не должен запускать drag & drop или обработку холста.
    event.preventDefault();
    event.stopPropagation();
    const moduleId = toggle.getAttribute('data-toggle-module');
    cancelModuleToggle();
    moduleToggleTimer = setTimeout(() => {
      moduleToggleTimer = null;
      toggleModule(moduleId);
    }, 250);
  }

  function onModuleToggleKeyDown(event) {
    const toggle = event.target.closest?.('[data-toggle-module]');
    if (!toggle || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    toggleModule(toggle.getAttribute('data-toggle-module'));
  }

  /* ----------------------------- Стикеры: действия ---------------------- */

  function setNotePlacing(enabled) {
    notePlacing = Boolean(enabled);
    if (notePlacing) {
      if (editing) commitInlineEdit();
      clearConnectionDraft();
      clearSelection();
      selectedConnectionId = null;
    }
    dom.addNoteBtn?.classList.toggle('is-active', notePlacing);
    dom.addNoteBtn?.setAttribute('aria-pressed', String(notePlacing));
    dom.svgWrap?.classList.toggle('is-note-placing', notePlacing);
    dom.canvasShell?.classList.toggle('is-note-placing', notePlacing);
    updateConnectionUI();
    if (notePlacing) {
      showToast('Кликните по холсту, чтобы поставить заметку · Esc — отмена', 'success', 2800);
    }
  }

  function addNoteAt(point) {
    if (!project || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    if (!Array.isArray(project.notes)) project.notes = [];

    const position = clampNotePosition(point.x - NOTE_WIDTH / 2, point.y - 18);
    const note = { id: makeId('note'), text: '', x: position.x, y: position.y };
    project.notes.push(note);
    selectedNoteId = note.id;
    persistProject();
    commitHistory();
    renderAll();

    // Свежесозданный стикер сразу готов к вводу, но двойной клик по нему
    // (и ПКМ → «Изменить текст») открывает то же поле повторно.
    const element = dom.notesLayer?.querySelector(`[data-note-id="${note.id}"]`);
    if (element) openInlineEditor('note', note.id, element);
    return note;
  }

  function removeNote(noteId) {
    const list = notes();
    const index = list.findIndex((note) => note.id === noteId);
    if (index < 0) return false;
    list.splice(index, 1);
    if (selectedNoteId === noteId) selectedNoteId = null;
    persistProject();
    commitHistory();
    renderAll();
    return true;
  }

  function onNoteDblClick(event) {
    const direct = event.target;
    const target = direct?.closest?.('[data-note-id]') ? direct : hitElementAtEvent(event);
    const noteElement = target?.closest?.('[data-note-id]');
    if (!noteElement || target.closest?.('[data-delete-note]')) return;
    const noteId = noteElement.getAttribute('data-note-id');
    if (!noteById(noteId)) return;
    event.preventDefault();
    event.stopPropagation();
    selectedNoteId = noteId;
    openInlineEditor('note', noteId, noteElement);
  }

  function onCanvasClick(event) {
    if (performance.now() < suppressCanvasClickUntil) return;

    // Второй (и последующий) клик двойного щелчка обрабатывается только
    // обработчиком dblclick — иначе он может нажать кнопку × появившегося
    // после первого клика выделения и удалить провод.
    if (event.detail > 1) {
      cancelWireSelection();
      return;
    }

    // Единая точка перевода курсора в координаты схемы для всех кликов по
    // холсту (порты, фон). getScreenCTM().inverse() учитывает текущий зум.
    const svgPoint = getSVGCoords(event);

    // Режим «Добавить заметку» одноразовый: клик по холсту ставит ровно один
    // стикер и сразу сбрасывает режим (курсор, подсветка кнопки, aria-pressed
    // и подсказка возвращаются в обычное состояние через setNotePlacing(false)).
    // Следующий клик без повторного нажатия кнопки заметку уже не создаст.
    if (notePlacing) {
      if (spaceHeld || panState || gesture || dragState) return;
      event.preventDefault();
      addNoteAt(svgPoint);
      setNotePlacing(false);
      return;
    }

    const deleteNote = event.target.closest('[data-delete-note]');
    if (deleteNote) {
      removeNote(deleteNote.getAttribute('data-delete-note'));
      return;
    }

    const deleteModule = event.target.closest('[data-delete-module]');
    if (deleteModule) {
      removeModule(deleteModule.getAttribute('data-delete-module'));
      return;
    }

    const deleteWire = event.target.closest('[data-delete-wire]');
    if (deleteWire) {
      removeConnection(deleteWire.getAttribute('data-delete-wire'));
      return;
    }

    const deleteRail = event.target.closest('[data-delete-rail]');
    if (deleteRail) {
      removeRail(deleteRail.getAttribute('data-delete-rail'));
      return;
    }

    const capButton = event.target.closest('[data-rail-capacity]');
    if (capButton) {
      changeRailCapacity(
        capButton.getAttribute('data-rail-id'),
        capButton.getAttribute('data-rail-capacity') === 'increase' ? 1 : -1
      );
      return;
    }

    const sourceToggle = event.target.closest('[data-toggle-source]');
    if (sourceToggle) {
      event.preventDefault();
      toggleSource();
      return;
    }

    // Сначала обычный DOM-хит, затем координатный — надёжность на любом зуме.
    const port = event.target.closest('[data-port-id]') || portElementAtPoint(svgPoint);
    if (port) {
      onPortClick(port);
      return;
    }

    const wire = event.target.closest('[data-connection-id]');
    if (wire) {
      scheduleWireSelection(wire.getAttribute('data-connection-id'));
      return;
    }

    const moduleElement = event.target.closest('[data-module-id]');
    if (moduleElement) {
      toggleModuleSelection(moduleElement.getAttribute('data-module-id'), event.shiftKey);
      return;
    }

    const noteElement = event.target.closest('[data-note-id]');
    if (noteElement) {
      clearSelection();
      cancelWireSelection();
      selectedConnectionId = null;
      selectedNoteId = noteElement.getAttribute('data-note-id');
      renderAll();
      return;
    }

    // Клик по пустому месту снимает выделение модулей/провода и выбор порта.
    clearSelection();
    cancelWireSelection();
    selectedConnectionId = null;
    if (activePort || pendingWire) clearConnectionDraft();
    renderAll();
  }

  /* ------------------- Inline editor (подписи) ------------------- */

  function hitElementAtEvent(event) {
    // Первый клик по проводу перерисовывает слой проводов, поэтому event.target
    // у dblclick может указывать на уже удалённый узел. elementFromPoint даёт
    // актуальный элемент под курсором и работает при любом масштабе холста.
    try {
      return document.elementFromPoint(event.clientX, event.clientY) || event.target;
    } catch (error) {
      return event.target;
    }
  }

  function closeInlineEditor() {
    if (!editing) return;
    editing = null;
    currentEditingId = null;
    currentEditingType = null;
    if (dom.inlineEditor) dom.inlineEditor.hidden = true;
  }

  function commitInlineEdit() {
    if (!editing || !dom.inlineEditor) return;
    const { kind, id } = editing;
    const isModule = kind === 'module';
    const isName = kind === 'name';
    const isPower = kind === 'loadPower';
    const isNote = kind === 'note';
    const field = isPower ? 'power'
      : (isName ? 'name' : (isModule ? 'description' : (isNote ? 'text' : 'label')));
    const value = isPower
      ? normalizeLoadPower(dom.inlineEditor.value, DEFAULT_LOAD_POWER)
      : safeText(
          dom.inlineEditor.value,
          '',
          isName ? MAX_MODULE_NAME_LENGTH
            : (isModule ? MAX_MODULE_DESCRIPTION_LENGTH
              : (isNote ? MAX_NOTE_TEXT_LENGTH : MAX_WIRE_LABEL_LENGTH))
        );
    closeInlineEditor();

    const item = isNote
      ? noteById(id)
      : ((isModule || isPower || isName)
        ? moduleById(id)
        : project.connections.find((connection) => connection.id === id));
    if (!item || item[field] === value) return;
    item[field] = value;
    persistProject();
    commitHistory();
    renderAll();
  }

  function cancelInlineEdit() {
    closeInlineEditor();
  }

  function onInlineEditorKeyDown(event) {
    if (!editing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commitInlineEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelInlineEdit();
    }
  }

  function onInlineEditorPointerDown(event) {
    // Поле редактирования — отдельный жест: он не должен доходить до холста
    // (панорамирование, выбор порта, перетаскивание модуля).
    event.stopPropagation();
  }

  function openInlineEditor(kind, id, anchor) {
    if (!dom.inlineEditor || !anchor) return;
    const isModule = kind === 'module';
    const isName = kind === 'name';
    const isPower = kind === 'loadPower';
    const isNote = kind === 'note';
    const item = isNote
      ? noteById(id)
      : ((isModule || isPower || isName)
        ? moduleById(id)
        : project.connections.find((connection) => connection.id === id));
    if (!item) return;

    // Фиксируем прямоугольник до сохранения предыдущего поля: commitInlineEdit()
    // может перерисовать SVG, после чего старый DOM-узел якоря уже исчезнет.
    const anchorRect = anchor.getBoundingClientRect();

    // Если уже открыто другое поле — сохраняем его перед переключением.
    commitInlineEdit();
    clearConnectionDraft();

    const field = isPower ? 'power'
      : (isName ? 'name' : (isModule ? 'description' : (isNote ? 'text' : 'label')));
    editing = { kind, id, anchorRect };
    // Глобальная привязка поля к редактируемому элементу.
    currentEditingId = id;
    currentEditingType = kind;
    const editor = dom.inlineEditor;
    const context = isPower ? 'Мощность нагрузки, Вт'
      : (isName ? 'Название модуля'
        : (isModule ? 'Описание модуля' : (isNote ? 'Текст заметки' : 'Маркировка провода')));
    editor.type = isPower ? 'number' : 'text';
    if (isPower) {
      editor.min = String(MIN_LOAD_POWER);
      editor.max = String(MAX_LOAD_POWER);
      editor.step = '1';
      editor.removeAttribute('maxlength');
    } else {
      editor.removeAttribute('min');
      editor.removeAttribute('max');
      editor.removeAttribute('step');
      editor.maxLength = isName
        ? MAX_MODULE_NAME_LENGTH
        : (isModule ? MAX_MODULE_DESCRIPTION_LENGTH
          : (isNote ? MAX_NOTE_TEXT_LENGTH : MAX_WIRE_LABEL_LENGTH));
    }
    editor.value = isPower
      ? String(normalizeLoadPower(item.power, DEFAULT_LOAD_POWER))
      : (item[field] || '');
    editor.title = `${context} · Enter — сохранить, Esc — отмена`;
    editor.setAttribute('aria-label', context);
    editor.placeholder = isPower
      ? `Например: 2000 · I = P / ${NOMINAL_VOLTAGE} · Enter — сохранить`
      : (isName
          ? 'Например: Автомат C16 · Enter — сохранить'
          : (isModule
              ? 'Например: Розетки в туалете · Enter — сохранить'
              : (isNote
                  ? 'Например: Проверить заземление · Enter — сохранить'
                  : 'Например: Свет в комнате · Enter — сохранить')));
    editor.hidden = false;
    placeOverlay(editor, editing.anchorRect, 10);
    editor.focus({ preventScroll: true });
    editor.select();
  }

  // Двойной клик по невидимому хало провода. Слушатель висит на слое проводов
  // и реагирует только на .wire-halo (или на подложку уже созданной подписи),
  // поэтому видимая линия с pointer-events: none здесь ни при чём.
  function onWireDblClick(event) {
    // Сначала DOM-цель (работает и для синтетических событий без координат),
    // затем актуальный элемент под курсором (если первый клик перерисовал слой).
    const direct = event.target;
    const target = direct?.closest?.('.wire-halo') || direct?.closest?.('[data-connection-id]')
      ? direct
      : hitElementAtEvent(event);
    const wire = target?.closest?.('.wire-halo') ||
                 target?.closest?.('[data-connection-id]');
    if (!wire) return;
    event.preventDefault();
    event.stopPropagation();
    cancelWireSelection();
    const connectionId = wire.getAttribute('data-connection-id');
    if (connectionId) openInlineEditor('wire', connectionId, wire);
  }

  // Слой модулей ловит двойной клик в том числе по рычажку — иначе центр
  // автомата перехватывается одиночным переключением и подпись не открывается.
  function onModuleDblClick(event) {
    const direct = event.target;
    const target = direct?.closest?.('[data-module-id]') ? direct : hitElementAtEvent(event);
    const moduleElement = target?.closest?.('[data-module-id]');
    // Порт лежит внутри модуля: двойной клик по клемме не должен открывать
    // редактор описания модуля.
    if (!moduleElement || target.closest?.('[data-delete-module], [data-port-id]')) return;
    const moduleId = moduleElement.getAttribute('data-module-id');
    if (!moduleId || moduleId === POWER_SOURCE.id) return;
    event.preventDefault();
    event.stopPropagation();
    const module = moduleById(moduleId);
    cancelModuleToggle();
    openInlineEditor(isLoadModule(module) ? 'loadPower' : 'module', moduleId, moduleElement);
  }

  function onCanvasDblClick(event) {
    // Двойной клик не должен вызывать перетаскивание, выбор порта или другие
    // действия холста.
    event.preventDefault();
    event.stopPropagation();
    cancelWireSelection();

    const target = hitElementAtEvent(event);
    if (!target || target.closest?.('#inline-editor, .inline-editor-input')) return;
    // Провода обрабатывает onWireDblClick, модули — onModuleDblClick;
    // остальные служебные элементы оставляем их собственным обработчикам.
    if (target.closest?.('[data-connection-id], [data-module-id], [data-note-id], [data-delete-note], [data-delete-module], [data-delete-wire], [data-delete-rail], [data-rail-capacity], [data-toggle-module], [data-toggle-source], [data-port-id]')) return;
  }

  function onCanvasKeyDown(event) {
    const sourceToggle = event.target.closest('[data-toggle-source]');
    if (sourceToggle && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      toggleSource();
      return;
    }

    const deleteModule = event.target.closest('[data-delete-module]');
    if (deleteModule && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      removeModule(deleteModule.getAttribute('data-delete-module'));
      return;
    }

    const deleteWire = event.target.closest('[data-delete-wire]');
    if (deleteWire && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      removeConnection(deleteWire.getAttribute('data-delete-wire'));
      return;
    }

    const deleteNote = event.target.closest('[data-delete-note]');
    if (deleteNote && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      removeNote(deleteNote.getAttribute('data-delete-note'));
      return;
    }

    const noteElement = event.target.closest('[data-note-id]');
    if (noteElement && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onNoteDblClick(event);
      return;
    }

    const deleteRail = event.target.closest('[data-delete-rail]');
    if (deleteRail && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      removeRail(deleteRail.getAttribute('data-delete-rail'));
      return;
    }

    const capButton = event.target.closest('[data-rail-capacity]');
    if (capButton && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      changeRailCapacity(
        capButton.getAttribute('data-rail-id'),
        capButton.getAttribute('data-rail-capacity') === 'increase' ? 1 : -1
      );
      return;
    }

    const port = event.target.closest('[data-port-id]');
    if (port && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onPortClick(port);
      return;
    }

    const wire = event.target.closest('[data-connection-id]');
    if (wire) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectConnection(wire.getAttribute('data-connection-id'));
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeConnection(wire.getAttribute('data-connection-id'));
      }
    }
  }

  function onGlobalKeyDown(event) {
    const isEditable = event.target.matches?.('input, textarea, select, [contenteditable="true"]');
    const inDialog = Boolean(event.target.closest?.('dialog'));

    // Открытое контекстное меню закрывается по Escape и по любой «рабочей»
    // клавише. Ctrl+C / Ctrl+V проходят дальше и работают с буфером модулей.
    if (contextMenuState) {
      const isClipboardKey = (event.ctrlKey || event.metaKey) &&
        ['c', 'v'].includes(event.key.toLowerCase());
      if (event.key === 'Escape' || !isClipboardKey) {
        if (event.key === 'Escape') event.preventDefault();
        closeContextMenu();
        if (event.key === 'Escape') return;
      }
    }

    // Пока открыто inline-поле, горячие клавиши холста не должны удалять
    // элементы или сбрасывать выделение. Delete/Backspace внутри самого поля
    // остаются обычным редактированием текста (preventDefault не нужен).
    if (editing) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!isEditable) event.preventDefault();
        return;
      }
      if (event.key === 'Escape' && !isEditable) {
        event.preventDefault();
        cancelInlineEdit();
        return;
      }
    }

    // Пробел — модификатор панорамирования; не перехватываем ввод и активацию
    // сфокусированных кнопок/портов (там пробел работает как Enter).
    if (event.code === 'Space' && !isEditable && !inDialog) {
      spaceHeld = true;
      dom.svgWrap.classList.add('is-space-ready');
      if (!event.target.closest?.('button, a, [role="button"], [data-port-id]')) {
        event.preventDefault(); // чтобы страница не прокручивалась
      }
    }

    if (event.key === 'Home' && !isEditable && !inDialog &&
        !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      resetView();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey && !isEditable &&
        !event.target.closest?.('dialog')) {
      const key = event.key.toLowerCase();
      // Буфер обмена модулями: Ctrl+C — скопировать выделенные, Ctrl+V —
      // вставить в точку курсора на холсте (или в центр текущего вида).
      if (key === 'c') {
        event.preventDefault();
        if (activeTab === 'marking') copyMarkingToClipboard();
        else copyModulesToClipboard();
        return;
      }
      if (key === 'v') {
        event.preventDefault();
        if (activeTab === 'marking') pasteMarkingFromClipboard();
        else pasteModulesAt(lastPointerSvgPoint || defaultPastePoint());
        return;
      }
      // Склейка выделенных модулей: Ctrl+G / Ctrl+Shift+G (разъединение).
      if (key === 'g') {
        event.preventDefault();
        if (event.shiftKey) ungroupSelectedModules();
        else groupSelectedModules();
        return;
      }
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === 'y') {
        event.preventDefault();
        redo();
        return;
      }
    }

    if (event.key === 'Escape') {
      if (event.target.closest?.('dialog')) return;
      if (!dom.markingEditor.hidden) {
        closeMarkingEditor();
        return;
      }
      if (notePlacing) {
        setNotePlacing(false);
        return;
      }
      if (selectionBoxState) {
        cancelSelectionBox();
        return;
      }
      if (dragState || gesture) {
        cancelActiveInteraction();
        return;
      }
      if (activePort || pendingWire) {
        clearConnectionDraft();
        renderAll();
        return;
      }
      if (selectedConnectionId) {
        selectedConnectionId = null;
        renderAll();
      }
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (isEditable) return;
      if (activeTab === 'marking') {
        if (!selectedMarkingId) return;
        event.preventDefault();
        deleteMarking();
        return;
      }
      if (!selectedModuleIds.size && !selectedConnectionId && !selectedNoteId) return;
      if (event.target.matches?.('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      deleteSelected();
    }
  }

  function onGlobalKeyUp(event) {
    if (event.code !== 'Space') return;
    spaceHeld = false;
    dom.svgWrap.classList.remove('is-space-ready');
  }

  function onConnectionsListClick(event) {
    const button = event.target.closest('[data-remove-connection]');
    if (!button) return;
    removeConnection(button.getAttribute('data-remove-connection'));
  }

  /* ------------------------------ Clear ------------------------------- */

  function clearProject() {
    if (allModules().length === 0 && project.connections.length === 0 && notes().length === 0) return;

    project.rails = [createRail()];
    project.connections = [];
    project.notes = [];
    project.markings = [];
    closeMarkingEditor();
    markingClipboard = null;
    selectedNoteId = null;
    project.source = { isOn: true };
    clearConnectionDraft();
    clearSelection();
    selectedConnectionId = null;
    resetInteractionState();
    persistProject();
    commitHistory();
    renderAll();
    showToast('Проект очищен. Название сохранено.', 'success', 2800);
  }

  function openClearDialog() {
    if (dom.clearProject.disabled) return;

    if (typeof dom.clearDialog.showModal !== 'function') {
      if (window.confirm('Удалить все модули и связи?')) clearProject();
      return;
    }

    dom.clearDialog.returnValue = 'cancel';
    dom.clearDialog.showModal();
  }

  function onClearDialogClose() {
    if (dom.clearDialog.returnValue === 'confirm') {
      clearProject();
    }
    dom.clearDialog.returnValue = 'cancel';
  }

  /* ---------------------------- Downloads ----------------------------- */

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function fileDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function safeFileName(value) {
    const cleaned = String(value || '')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return cleaned.slice(0, 60) || 'panel';
  }

  /* ------------------------ Project file (JSON) ----------------------- */

  // Актуальное состояние проекта в формате JSON-экспорта. Используется
  // и для скачивания файла, и для записи в облако, чтобы форматы совпадали.
  function buildProjectState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      project: {
        ...project,
        // Кастомные цены хранятся в самом проекте и попадают в JSON.
        // modulePrice() читает их по id элемента библиотеки при импорте.
        customPrices: { ...(project.customPrices || {}) },
        // Цены кабелей за метр — тоже часть проекта и восстанавливаются
        // normalizeProject() при импорте файла или загрузке из localStorage.
        customCablePrices: { ...(project.customCablePrices || {}) },
        // Состояния слоёв (видимость/блокировка) попадают в JSON и в
        // localStorage вместе с остальным проектом.
        layerSettings: normalizeLayerSettings(project.layerSettings)
      }
    };
  }

  // Экспорт: собираем всё актуальное состояние (рейки, модули, провода,
  // настройки) в один объект вместе с версией схемы и скачиваем как JSON.
  function exportProject() {
    const json = JSON.stringify(buildProjectState(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    downloadBlob(blob, 'panel-project.json');
    showToast('Проект сохранён в файл panel-project.json', 'success', 3000);
  }

  // Импорт: программно открываем системный диалог выбора файла.
  function openImportFileDialog() {
    if (!dom.importFile) return;
    dom.importFile.value = '';
    dom.importFile.click();
  }

  // Полная замена состояния загруженным (уже провалидированным) проектом.
  function applyImportedProject(rawProject) {
    const normalized = normalizeProject(rawProject);
    if (!normalized) return false;

    // Закрываем все «висячие» взаимодействия со старой схемой.
    closeInlineEditor();
    resetInteractionState();
    clearConnectionDraft();
    clearSelection();
    selectedConnectionId = null;

    project = normalized;

    dom.projectName.value = project.name;
    syncSimulationToggle();
    syncParamsToggle();
    updateDocumentTitle();
    persistProject();
    // История отмены тоже должна начинаться с загруженного состояния.
    resetHistory();

    // Возвращаем исходный вид: 100% масштаб без панорамирования.
    viewState.x = 0;
    viewState.y = 0;
    viewState.zoom = 1;
    applyView();

    renderAll();
    // Смета может быть уже открыта — обновляем и её, иначе цены из
    // импортированного проекта (в том числе кабельные) покажутся старыми.
    renderEstimate();
    return true;
  }

  // Чтение выбранного файла: FileReader -> JSON.parse -> валидация ->
  // замена состояния. Независимо от исхода поле ввода очищается, чтобы
  // пользователь мог повторно выбрать тот же самый файл.
  function onImportFileChange(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    const resetInput = () => { input.value = ''; };

    if (!file) {
      resetInput();
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let ok = false;
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        // Поддерживаем как наш формат { schemaVersion, project }, так и
        // «голый» объект проекта — главное, чтобы был массив rails.
        const candidate = parsed && typeof parsed === 'object' && parsed.project
          ? parsed.project
          : parsed;
        if (candidate && typeof candidate === 'object' &&
            !Array.isArray(candidate) && Array.isArray(candidate.rails)) {
          ok = applyImportedProject(candidate);
        }
      } catch (error) {
        ok = false;
      }
      resetInput();
      if (ok) {
        showToast('Проект загружен', 'success', 3000);
      } else {
        showToast('Неверный формат файла', 'error', 3500);
      }
    };
    reader.onerror = () => {
      resetInput();
      showToast('Неверный формат файла', 'error', 3500);
    };
    reader.readAsText(file, 'utf-8');
  }

  /* --------------------- Авторизация (Supabase Auth) ------------------- */

  function setAuthError(message, info = false) {
    if (!dom.authError) return;
    dom.authError.textContent = message || '';
    dom.authError.classList.toggle('is-info', Boolean(info) && Boolean(message));
    dom.authError.hidden = !message;
  }

  function clearAuthError() {
    if (dom.authError && !dom.authError.hidden) setAuthError('');
  }

  function showAuthDialog() {
    if (!dom.authDialog) return;
    clearAuthError();
    if (typeof dom.authDialog.showModal === 'function') {
      if (!dom.authDialog.open) dom.authDialog.showModal();
    } else {
      dom.authDialog.setAttribute('open', '');
    }
  }

  function hideAuthDialog() {
    if (dom.authDialog?.open) dom.authDialog.close();
    if (dom.authPasswordInput) dom.authPasswordInput.value = '';
    clearAuthError();
  }

  // Гость может пользоваться редактором; облачные кнопки остаются видимыми,
  // но при нажатии requireAuth() откроет окно входа. Блокируем их только
  // во время запроса и если библиотека Supabase вообще не загрузилась.
  function syncCloudControls() {
    const disabled = cloudBusy || !supabase;
    [dom.cloudSave, dom.cloudLoad].forEach((button) => {
      if (!button) return;
      button.disabled = disabled;
      button.title = currentUser
        ? (button === dom.cloudSave
            ? 'Сохранить текущий проект в облако (Supabase)'
            : 'Загрузить проект из облака (Supabase)')
        : 'Сначала войдите в аккаунт';
    });
  }

  function applyAuthSession(user) {
    currentUser = user || null;
    const signedIn = Boolean(currentUser);
    if (dom.authLogin) dom.authLogin.hidden = signedIn;
    if (dom.authLogout) dom.authLogout.hidden = !signedIn;
    if (dom.authEmail) {
      dom.authEmail.hidden = !signedIn;
      dom.authEmail.textContent = currentUser?.email || '';
      dom.authEmail.title = currentUser?.email || '';
    }
    if (signedIn) hideAuthDialog();
    syncCloudControls();
  }

  function requireAuth() {
    if (currentUser) return true;
    showToast('Сначала войдите в аккаунт', 'error', 3500);
    showAuthDialog();
    return false;
  }

  // Supabase Auth возвращает сообщение об ошибке в error.message — именно его
  // и показываем в красной плашке (например, "Invalid login credentials").
  function authErrorMessage(error) {
    return String(error?.message || error || 'Неизвестная ошибка');
  }

  function setAuthBusy(busy) {
    [dom.authSigninBtn, dom.authSignupBtn].forEach((button) => {
      if (button) button.disabled = busy;
    });
  }

  function readAuthCredentials() {
    const email = String(dom.authEmailInput?.value || '').trim();
    const password = String(dom.authPasswordInput?.value || '');
    if (!email || !password) {
      setAuthError('Введите email и пароль.');
      return null;
    }
    return { email, password };
  }

  async function signInWithEmail() {
    if (!supabase) {
      console.error('Supabase не инициализирован');
      setAuthError('Сервис авторизации недоступен.');
      return;
    }
    const credentials = readAuthCredentials();
    if (!credentials) return;
    clearAuthError();
    console.log('Попытка входа:', credentials.email);
    setAuthBusy(true);
    try {
      // Supabase Auth v2 возвращает { data, error }, а не Response —
      // проверять нужно error, а не response.ok / res.ok.
      const { data, error } = await supabase.auth.signInWithPassword({
        email: credentials.email,
        password: credentials.password
      });
      if (error) throw error;
      applyAuthSession(data?.user || null);
      showToast('Вы вошли в аккаунт', 'success', 2600);
    } catch (err) {
      console.error(err);
      setAuthError(authErrorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signUpWithEmail() {
    if (!supabase) {
      console.error('Supabase не инициализирован');
      setAuthError('Сервис авторизации недоступен.');
      return;
    }
    const credentials = readAuthCredentials();
    if (!credentials) return;
    clearAuthError();
    console.log('Попытка регистрации:', credentials.email);
    setAuthBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: credentials.email,
        password: credentials.password
      });
      if (error) throw error;
      if (data?.session) {
        // Подтверждение email выключено — сессия активна сразу.
        applyAuthSession(data.user);
        showToast('Регистрация выполнена', 'success', 2800);
      } else {
        // Подтверждение включено: пользователь сможет войти после перехода
        // по ссылке из письма с тем же паролем.
        setAuthError('Регистрация создана. Подтвердите email по ссылке в письме, затем войдите.', true);
      }
    } catch (err) {
      console.error(err);
      setAuthError(authErrorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOutUser() {
    if (!supabase) return;
    setAuthBusy(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      applyAuthSession(null);
      if (dom.cloudDialog?.open) dom.cloudDialog.close();
      showToast('Вы вышли из аккаунта. Просмотр доступен без входа.', 'success', 3200);
    } catch (error) {
      reportCloudError('Ошибка выхода из аккаунта', error);
    } finally {
      setAuthBusy(false);
    }
  }

  // Проверка сессии при загрузке страницы. onAuthStateChange дополнительно
  // синхронизирует UI при обновлении токена и входе/выходе из другой вкладки.
  async function initAuth() {
    syncCloudControls();
    if (!supabase) {
      setAuthError('Не удалось загрузить сервис авторизации. Проверьте соединение.');
      showToast('Облако недоступно: не загрузилась библиотека Supabase', 'error', 5000);
      return;
    }
    try {
      supabase.auth.onAuthStateChange((_event, session) => {
        applyAuthSession(session?.user || null);
      });
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      const session = data?.session || null;
      applyAuthSession(session?.user || null);
      if (!session) {
        // Гость видит весь сайт и работает локально; окно входа открывается
        // только по кнопке «Войти» или при попытке сохранить/загрузить облако.
        showToast('Просмотр доступен без входа. Нажмите «Войти» для работы с облаком.', 'success', 6500);
      }
    } catch (error) {
      console.error('[Щит.Студия] Ошибка проверки сессии:', error);
      setAuthError('Не удалось проверить сессию. Попробуйте войти ещё раз.');
      showToast('Не удалось проверить сессию. Вы можете продолжить без входа.', 'error', 5000);
    }
  }

  /* --------------------- Проекты в облаке (Supabase) ------------------- */

  const CLOUD_CONNECTION_ERROR = 'Ошибка подключения к облаку';
  // Статическая разметка иконки корзины: данные из базы всегда выводятся
  // через textContent, в HTML попадает только эта константа.
  const TRASH_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M4.5 6h11M8 6V4.5h4V6m-6 0 .7 10h6.6L14 6M8.6 9v4.4M11.4 9v4.4" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function setCloudBusy(busy) {
    cloudBusy = Boolean(busy);
    syncCloudControls();
  }

  function reportCloudError(context, error, message = CLOUD_CONNECTION_ERROR) {
    console.error(`[Щит.Студия] ${context}:`, error);
    showToast(message, 'error', 3500);
  }

  function formatCloudDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'дата неизвестна';
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  }

  // Сохранение текущего проекта в таблицу projects с привязкой к пользователю.
  async function saveProjectToCloud() {
    if (!project) return;
    if (!requireAuth()) return;
    if (!supabase) {
      reportCloudError('Supabase не инициализирован', new Error('Нет подключения к Supabase'));
      return;
    }

    const suggested = String(dom.projectName?.value || project.name || '').trim() || 'Новый щит';
    const answer = window.prompt('Имя проекта для сохранения в облако:', suggested);
    if (answer === null) return; // пользователь отменил ввод

    const projectName = answer.trim().slice(0, 60) || suggested;
    // Введённое имя становится текущим — в шапке и в локальном проекте.
    project.name = projectName;
    if (dom.projectName) dom.projectName.value = projectName;
    persistProject();
    updateDocumentTitle();

    setCloudBusy(true);
    try {
      // Перед вставкой получаем текущего пользователя: user_id записывается
      // в строку и используется политикой RLS для разделения проектов.
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!user) {
        applyAuthSession(null);
        requireAuth();
        return;
      }
      const { error } = await supabase
        .from('projects')
        .insert([{ name: projectName, data: buildProjectState(), user_id: user.id }]);
      if (error) throw error;
      showToast('Проект сохранен в облако!', 'success', 3200);
    } catch (error) {
      const message = String(error?.message || '').toLowerCase();
      if (message.includes('user_id') && message.includes('does not exist')) {
        reportCloudError('Ошибка сохранения проекта', error,
          'В таблице projects нет колонки user_id. Добавьте её и включите RLS.');
      } else if (message.includes('row-level security')) {
        reportCloudError('Ошибка сохранения проекта', error,
          'Нет прав на запись в облако. Проверьте RLS-политику.');
      } else {
        reportCloudError('Ошибка сохранения проекта в Supabase', error);
      }
    } finally {
      setCloudBusy(false);
    }
  }

  // Преобразование строки облака в объект проекта (поддерживаем как наш
  // формат { schemaVersion, project }, так и «голый» объект с массивом rails).
  function cloudRowToProject(row) {
    let payload = row && typeof row === 'object' ? row.data : null;
    if (typeof payload === 'string') {
      payload = JSON.parse(payload);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const candidate = payload.project && typeof payload.project === 'object'
      ? payload.project
      : payload;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        !Array.isArray(candidate.rails)) {
      return null;
    }
    return candidate;
  }

  // Применение выбранного облачного проекта к текущему состоянию приложения.
  // applyImportedProject() делает валидацию, перерисовку всех слоёв, сброс
  // истории Undo/Redo и сохранение в localStorage — тот же путь, что и импорт.
  function loadProjectFromCloud(row) {
    let candidate = null;
    try {
      candidate = cloudRowToProject(row);
    } catch (error) {
      reportCloudError('Не удалось прочитать данные проекта из облака', error);
      return;
    }

    if (!candidate) {
      reportCloudError('Некорректные данные проекта из облака',
        new Error('В записи нет корректного объекта проекта'));
      return;
    }

    if (applyImportedProject(candidate)) {
      if (dom.cloudDialog?.open) dom.cloudDialog.close();
      showToast('Проект загружен!', 'success', 3000);
    } else {
      reportCloudError('Не удалось применить проект из облака',
        new Error('normalizeProject() вернул null'));
    }
  }

  function renderCloudEmpty() {
    if (!dom.cloudDialogList) return;
    const empty = document.createElement('p');
    empty.className = 'cloud-project-empty';
    empty.textContent = 'У вас пока нет сохранённых проектов.';
    dom.cloudDialogList.replaceChildren(empty);
  }

  function renderCloudProjectList(rows) {
    if (!dom.cloudDialogList) return;
    if (!rows.length) {
      renderCloudEmpty();
      return;
    }

    dom.cloudDialogList.replaceChildren();
    rows.forEach((row) => {
      const name = safeText(row.name, 'Без названия', 60) || 'Без названия';
      const item = document.createElement('div');
      item.className = 'cloud-project-item';
      item.setAttribute('role', 'listitem');

      const info = document.createElement('div');
      info.className = 'cloud-project-info';
      const title = document.createElement('strong');
      title.textContent = name;
      const meta = document.createElement('span');
      meta.textContent = formatCloudDate(row.updated_at || row.created_at);
      info.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'cloud-project-actions';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'btn btn-cloud-load';
      loadBtn.textContent = 'Загрузить';
      loadBtn.title = `Загрузить проект «${name}»`;
      loadBtn.addEventListener('click', () => loadProjectFromCloud(row));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-cloud-delete';
      deleteBtn.innerHTML = TRASH_ICON;
      deleteBtn.title = `Удалить проект «${name}»`;
      deleteBtn.setAttribute('aria-label', deleteBtn.title);
      deleteBtn.addEventListener('click', () => deleteCloudProject(row, item));

      actions.append(loadBtn, deleteBtn);
      item.append(info, actions);
      dom.cloudDialogList.appendChild(item);
    });
  }

  // Удаление строки из таблицы projects и соответствующей строки из списка.
  async function deleteCloudProject(row, item) {
    if (!requireAuth()) return;
    if (!supabase) {
      reportCloudError('Supabase не инициализирован', new Error('Нет подключения к Supabase'));
      return;
    }
    if (!window.confirm('Точно удалить проект?')) return;

    const buttons = Array.from(item.querySelectorAll('button'));
    buttons.forEach((button) => { button.disabled = true; });
    setCloudBusy(true);
    try {
      const { error } = await supabase.from('projects').delete().eq('id', row.id);
      if (error) throw error;
      item.remove();
      if (!dom.cloudDialogList?.children.length) renderCloudEmpty();
      showToast('Проект удалён', 'success', 2600);
    } catch (error) {
      reportCloudError('Ошибка удаления проекта из Supabase', error);
      buttons.forEach((button) => { button.disabled = false; });
    } finally {
      setCloudBusy(false);
    }
  }

  // Загрузка списка проектов и открытие диалога «Мои проекты».
  // Supabase сам ограничивает выборку политикой RLS по текущему user_id.
  async function openCloudProjectDialog() {
    if (!requireAuth()) return;
    if (!supabase) {
      reportCloudError('Supabase не инициализирован', new Error('Нет подключения к Supabase'));
      return;
    }

    setCloudBusy(true);
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) throw error;

      renderCloudProjectList(Array.isArray(data) ? data : []);
      if (!dom.cloudDialog) return;
      if (typeof dom.cloudDialog.showModal === 'function') {
        if (!dom.cloudDialog.open) dom.cloudDialog.showModal();
      } else {
        dom.cloudDialog.setAttribute('open', '');
      }
    } catch (error) {
      const message = String(error?.message || '').toLowerCase();
      if (message.includes('row-level security')) {
        reportCloudError('Ошибка загрузки списка проектов', error,
          'Нет прав на чтение облака. Проверьте RLS-политику.');
      } else {
        reportCloudError('Ошибка загрузки списка проектов из Supabase', error);
      }
    } finally {
      setCloudBusy(false);
    }
  }

  /* ------------------------------- CSV -------------------------------- */

  function csvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const specification = buildSpecification();
    if (specification.length === 0) {
      showToast('Спецификация пуста — добавьте модули.', 'error', 3000);
      return;
    }

    const rows = [
      ['Название модуля', 'Бренд', 'Артикул', 'Тег', 'Количество', 'Статус', 'Описание'],
      ...specification.map((item) => [
        item.name,
        item.brand,
        item.sku,
        item.tags.join(', '),
        item.count,
        specificationStatusLabel(item),
        item.descriptions.join('; ')
      ])
    ];

    if (project.connections.length > 0) {
      rows.push([]);
      rows.push(['Соединения']);
      rows.push(['От', 'К', 'Тип', 'Маркировка']);
      for (const connection of project.connections) {
        rows.push([
          connectionPortLabel(connection, 'from'),
          connectionPortLabel(connection, 'to'),
          connection.type,
          typeof connection.label === 'string' ? connection.label : ''
        ]);
      }

      // Сводка по типам проводников: L1, L2, L3, N, PE.
      const wireCounts = getWireCounts();
      rows.push([]);
      rows.push(['Провода по типам']);
      rows.push(['Тип', 'Количество']);
      for (const key of WIRE_TYPE_KEYS) {
        rows.push([WIRE_TYPES[key].label, wireCounts[key]]);
      }
    }

    // Расход кабеля по типам — в конце файла, вместе с параметрами расчёта.
    const wireLengths = calculateWireLengths();
    const reservePercent = Math.round((WIRE_LENGTH_RESERVE - 1) * 100);
    rows.push([]);
    rows.push(['Расход кабеля']);
    rows.push([`Длина с запасом ${reservePercent}% на изгибы и разделку`]);
    rows.push([`Масштаб: 1 модуль DIN = 18 мм (${MODULE_UNIT} px)`]);
    rows.push(['Тип', 'Длина, м', 'Цена, руб/м', 'Сумма, руб']);
    for (const key of WIRE_TYPE_KEYS) {
      const price = wirePrice(key);
      const meters = wireLengths[key];
      rows.push([
        `Кабель ${WIRE_TYPES[key].label}`,
        meters.toFixed(1),
        csvNumber(price),
        csvNumber(roundMoney(meters * price))
      ]);
    }

    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `specification-${fileDate()}.csv`);

    showToast('Спецификация экспортирована в CSV', 'success', 2600);
  }

  /* --------------------------- Смета (BOM) ---------------------------- */

  const MONEY_FORMATTER = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });

  function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function formatMoney(value) {
    return MONEY_FORMATTER.format(roundMoney(value));
  }

  function formatQty(row) {
    return row.unit === 'м'
      ? row.qty.toFixed(1).replace('.', ',')
      : String(row.qty);
  }

  // В русской локали Excel использует ',' как десятичный разделитель
  // и ';' как разделитель столбцов.
  function csvNumber(value) {
    return String(value).replace('.', ',');
  }

  // Смета = сгруппированные по id модули + пять строк проводов.
  // Одинаковые модули попадают в одну строку с суммарным количеством.
  function buildEstimate() {
    const items = buildSpecification();
    const rows = items.map((item) => ({
      kind: 'module',
      // key нужен инлайн-редактору цены: по нему значение пишется в
      // project.customPrices и читается обратно при каждом пересчёте сметы.
      key: item.key,
      name: item.name,
      brand: item.brand || '—',
      sku: item.sku || '—',
      qty: item.count,
      unit: 'шт',
      price: roundMoney(item.price),
      total: roundMoney(item.price * item.count)
    }));

    // Провода всегда присутствуют в смете. Если соединений нет,
    // calculateWireLengths() вернёт 0 м — это и есть строка-заглушка.
    const wireLengths = calculateWireLengths();
    for (const key of WIRE_TYPE_KEYS) {
      const meters = wireLengths[key];
      // Редактируемая цена берётся из project.customCablePrices, иначе
      // используется базовая цена за метр. Сумма строки считается от неё же.
      const price = wirePrice(key);
      rows.push({
        kind: 'wire',
        // key нужен инлайн-редактору: по нему пишется customCablePrices[key].
        key,
        name: `Провод ${key}`,
        brand: 'Кабель',
        sku: `WIRE-${key}`,
        qty: meters,
        unit: 'м',
        price,
        total: roundMoney(meters * price)
      });
    }

    const total = roundMoney(rows.reduce((sum, row) => sum + row.total, 0));
    return { rows, total, hasModules: items.length > 0 };
  }

  function estimateTableHtml(rows, total) {
    // Заголовок блока кабелей — только визуальный: в CSV он не попадает.
    const body = rows.map((row, index) => {
      const section = row.kind === 'wire' && (index === 0 || rows[index - 1].kind !== 'wire')
        ? '<tr class="estimate-section-row"><td colspan="8">Кабельная продукция</td></tr>'
        : '';
      const priceText = escapeHtml(formatMoney(row.price));
      // Редактируются и модули, и провода: data-price-kind определяет,
      // в какой объект состояния (customPrices / customCablePrices) писать.
      const priceCell = `<td class="est-money est-price" data-price-kind="${row.kind}"
              data-price-key="${escapeHtml(row.key)}"
              data-price-value="${row.price}" tabindex="0" role="button"
              aria-label="Изменить цену: ${priceText} руб"
              title="Клик или Enter — изменить цену"><span class="est-price-value">${priceText}</span></td>`;
      return `${section}
          <tr>
            <td class="est-num">${index + 1}</td>
            <td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.brand)}</td>
            <td>${escapeHtml(row.sku)}</td>
            <td class="est-qty">${escapeHtml(formatQty(row))}</td>
            <td class="est-unit">${escapeHtml(row.unit)}</td>
            ${priceCell}
            <td class="est-money">${escapeHtml(formatMoney(row.total))}</td>
          </tr>`;
    }).join('');

    return `
      <table class="estimate-table">
        <thead>
          <tr>
            <th scope="col" class="est-num">№</th>
            <th scope="col">Наименование</th>
            <th scope="col">Бренд</th>
            <th scope="col">Артикул</th>
            <th scope="col" class="est-qty">Кол-во</th>
            <th scope="col" class="est-unit">Ед. изм.</th>
            <th scope="col" class="est-money" title="Нажмите на цену, чтобы изменить её">Цена (руб)</th>
            <th scope="col" class="est-money">Сумма (руб)</th>
          </tr>
        </thead>
        <tbody>${body}
        </tbody>
        <tfoot>
          <tr class="estimate-total-row">
            <td colspan="8">ИТОГО: <strong>${escapeHtml(formatMoney(total))} руб.</strong></td>
          </tr>
        </tfoot>
      </table>`;
  }

  /* ======================== Кабельный журнал ==========================
     Данные берутся из того же проекта, что и схема: марки W1, W2… назначаются
     по порядку проводов, адреса — из тегов модулей (QF1, QS1, XT1…) и портов
     источника, длина — из фактической полилинии провода на холсте.
     ==================================================================== */

  function buildJournal() {
    // Длины читаются из отрисованных полилиний, как и в спецификации:
    // при скрытой вкладке схемы разметка остаётся в DOM, поэтому расчёт
    // работает и когда пользователь уже перешёл в журнал.
    const polylines = new Map();
    if (dom.wireLayer) {
      dom.wireLayer.querySelectorAll('polyline[data-connection-id]').forEach((polyline) => {
        polylines.set(polyline.getAttribute('data-connection-id'), polyline);
      });
    }

    const rows = project.connections.map((connection, index) => {
      const typeKey = WIRE_TYPES[connection.type] ? connection.type : DEFAULT_WIRE_TYPE;
      const type = WIRE_TYPES[typeKey];
      const meters = (polylineLengthPx(polylines.get(connection.id)) / PIXELS_PER_METER) * WIRE_LENGTH_RESERVE;
      const length = Math.round(meters * 10) / 10;
      const label = typeof connection.label === 'string' ? connection.label.trim() : '';
      return {
        index: index + 1,
        id: connection.id,
        mark: `W${index + 1}`,
        from: connectionPortLabel(connection, 'from'),
        to: connectionPortLabel(connection, 'to'),
        type: type.label,
        typeKey,
        length,
        note: label || '—'
      };
    });

    const totalLength = Math.round(rows.reduce((sum, row) => sum + row.length, 0) * 10) / 10;
    return { rows, totalLength };
  }

  function journalRowsHtml(rows, interactive = true) {
    if (rows.length === 0) {
      return `<tr><td colspan="7" class="journal-empty">Проводов пока нет. Перейдите на вкладку «Схема щита», кликните по порту модуля, затем по второму порту и выберите тип провода.</td></tr>`;
    }

    return rows.map((row) => {
      const color = wireDisplayColor(row.typeKey);
      const noteText = escapeHtml(row.note);
      // На экране ячейка примечания — инлайн-редактор; в печатном листе
      // та же таблица выводится обычным текстом без атрибутов управления.
      const noteCell = interactive
        ? `<td class="j-note j-note-editable${row.note === '—' ? ' is-empty' : ''}"
               data-journal-note-id="${escapeHtml(row.id)}"
               tabindex="0" role="button"
               aria-label="Примечание провода ${escapeHtml(row.mark)}: ${noteText}. Клик или Enter — изменить"
               title="Клик или Enter — изменить примечание">${noteText}</td>`
        : `<td class="j-note">${noteText}</td>`;
      return `
        <tr>
          <td class="j-num">${row.index}</td>
          <td class="j-mark"><strong>${escapeHtml(row.mark)}</strong></td>
          <td>${escapeHtml(row.from)}</td>
          <td>${escapeHtml(row.to)}</td>
          <td class="j-type-col">
            <span class="j-type-label"><i class="j-type-dot" style="--wire-type-color:${color}" aria-hidden="true"></i>${escapeHtml(row.type)}</span>
          </td>
          <td class="j-length">${formatCableLength(row.length)}</td>
          ${noteCell}
        </tr>`;
    }).join('');
  }

  function journalTableHtml(rows, totalLength) {
    return `
      <table class="journal-table">
        <thead>
          <tr>
            <th scope="col" class="j-num">№</th>
            <th scope="col" class="j-mark">Марка</th>
            <th scope="col">Откуда</th>
            <th scope="col">Куда</th>
            <th scope="col" class="j-type-col">Тип</th>
            <th scope="col" class="j-length">Длина, м</th>
            <th scope="col" class="j-note">Примечание</th>
          </tr>
        </thead>
        <tbody>${journalRowsHtml(rows, false)}</tbody>
        ${rows.length ? `
        <tfoot>
          <tr class="journal-total-row">
            <td colspan="5">Итого: ${rows.length} ${plural(rows.length, ['провод', 'провода', 'проводов'])}</td>
            <td class="j-length">${formatCableLength(totalLength)}</td>
            <td></td>
          </tr>
        </tfoot>` : ''}
      </table>`;
  }

  function renderJournal() {
    const journal = buildJournal();
    const projectTitle = project?.name || 'Новый щит';
    const today = new Date().toLocaleDateString('ru-RU');

    if (dom.journalSubtitle) {
      dom.journalSubtitle.textContent =
        `${projectTitle} · ${today} · ${journal.rows.length} ${plural(journal.rows.length, ['провод', 'провода', 'проводов'])} · ${formatCableLength(journal.totalLength)}`;
    }
    if (dom.journalBody) dom.journalBody.innerHTML = journalRowsHtml(journal.rows);
    if (dom.journalFoot) dom.journalFoot.hidden = journal.rows.length === 0;
    if (dom.journalTotalCount) dom.journalTotalCount.textContent = String(journal.rows.length);
    if (dom.journalTotalLength) dom.journalTotalLength.textContent = formatCableLength(journal.totalLength);
    if (dom.journalDownloadCsv) dom.journalDownloadCsv.disabled = journal.rows.length === 0;
    if (dom.journalPrint) dom.journalPrint.disabled = journal.rows.length === 0;

    // Печатный лист строится из тех же данных, что и экранная таблица.
    if (dom.journalPrintSheet) {
      dom.journalPrintSheet.innerHTML = `<h1>Кабельный журнал</h1>
        <p class="print-meta">${escapeHtml(projectTitle)} · ${escapeHtml(today)}</p>
        ${journalTableHtml(journal.rows, journal.totalLength)}`;
    }
    return journal;
  }

  // Возвращает ячейку в текстовый вид без пересборки всей таблицы: иначе
  // blur предыдущего поля перерисовал бы tbody и «съел» клик по следующей ячейке.
  function restoreJournalNoteCell(cell, text) {
    const display = text || '—';
    const mark = cell.closest('tr')?.querySelector('.j-mark strong')?.textContent || 'провода';
    cell.classList.remove('is-editing');
    cell.classList.toggle('is-empty', !text);
    cell.textContent = display;
    cell.setAttribute('aria-label', `Примечание провода ${mark}: ${display}. Клик или Enter — изменить`);
  }

  // Инлайн-редактор примечания в кабельном журнале. Пишет в то же поле
  // connection.label, что и подпись провода на схеме: после сохранения
  // перерисовывается холст, и текст появляется над проводом.
  function startJournalNoteEdit(cell) {
    if (!cell || cell.classList.contains('is-editing')) return;
    const connectionId = cell.dataset.journalNoteId;
    const connection = project.connections.find((item) => item.id === connectionId);
    if (!connection) return;

    const previous = typeof connection.label === 'string' ? connection.label.trim() : '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'j-note-input';
    input.maxLength = MAX_JOURNAL_NOTE_LENGTH;
    input.value = previous; // пустая ячейка ("—") открывается пустым полем
    input.title = 'Enter — сохранить · Esc — отмена · потеря фокуса — сохранить';
    input.setAttribute('aria-label', 'Примечание провода');

    cell.replaceChildren(input);
    cell.classList.add('is-editing');
    input.focus();
    input.select();

    // Guard защищает от повторного сохранения: при возврате ячейки в текстовый
    // вид у удалённого поля срабатывает blur, но он уже ничего не должен менять.
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;

      // Не меняем данные, если поле просто открыли и закрыли без правки.
      const typed = input.value;
      const value = !commit || typed === previous
        ? previous // Esc — отмена: восстанавливаем прежний текст
        : safeText(typed, '', MAX_JOURNAL_NOTE_LENGTH);
      restoreJournalNoteCell(cell, value);
      if (value === previous) return;

      // Пустой текст убирает и подпись с провода, и примечание в журнале.
      connection.label = value;
      persistProject();
      commitHistory();
      // Холст перерисовывается целиком (новая подпись над проводом), таблица
      // журнала при этом остаётся нетронутой — фокус следующей ячейки жив.
      renderCanvas();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    // Правка ячейки — отдельный жест: он не должен доходить до глобальных
    // обработчиков холста, кнопок удаления и горячих клавиш.
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('dblclick', (event) => event.stopPropagation());
    input.addEventListener('blur', () => finish(true));
  }

  // Переключение вкладок. Журнал и маркировка пересобираются при каждом
  // входе: новые провода и описания модулей сразу попадают на печатный лист.
  function switchViewTab(tab) {
    activeTab = tab === 'journal' || tab === 'marking' ? tab : 'schema';
    const isSchema = activeTab === 'schema';
    const isJournal = activeTab === 'journal';
    const isMarking = activeTab === 'marking';
    if (!isSchema && notePlacing) setNotePlacing(false);
    if (!isSchema && !dom.markingEditor.hidden) closeMarkingEditor();

    const tabs = [
      [dom.tabSchema, isSchema],
      [dom.tabJournal, isJournal],
      [dom.tabMarking, isMarking]
    ];
    tabs.forEach(([button, active]) => {
      if (!button) return;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    if (dom.schemaView) dom.schemaView.hidden = !isSchema;
    if (dom.journalView) dom.journalView.hidden = !isJournal;
    if (dom.markingView) dom.markingView.hidden = !isMarking;
    document.body.classList.toggle('is-journal-tab', isJournal);
    document.body.classList.toggle('is-marking-tab', isMarking);

    if (isJournal && project) renderJournal();
    if (isMarking && project) renderMarking();
  }

  function exportJournalCsv() {
    const journal = renderJournal();
    if (journal.rows.length === 0) {
      showToast('Кабельный журнал пуст — добавьте провода на схеме.', 'error', 3000);
      return;
    }

    const rows = [
      ['№', 'Марка', 'Откуда', 'Куда', 'Тип провода', 'Длина, м', 'Примечание'],
      ...journal.rows.map((row) => [
        String(row.index),
        row.mark,
        row.from,
        row.to,
        row.type,
        csvNumber(row.length),
        row.note
      ]),
      ['', 'ИТОГО:', '', '', '', csvNumber(journal.totalLength), '']
    ];

    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `cable-journal-${safeFileName(project?.name)}-${fileDate()}.csv`);
    showToast('Кабельный журнал экспортирован в CSV', 'success', 2600);
  }

  function printJournal() {
    printContext = 'journal';
    renderJournal();
    window.print();
  }

  /* ====================================================================
     МАРКИРОВКА — лист наклеек в масштабе 1:1
     --------------------------------------------------------------------
     Источник данных — схема: каждый модуль даёт наклейку шириной
     width × 18 мм, каждый провод с непустым label — отдельную бирку.
     Правки пользователя хранятся в project.markings и автоматически
     попадают в localStorage, JSON-экспорт и историю Undo/Redo.
     ==================================================================== */

  function createMarkingSettings() {
    return { ...DEFAULT_MARKING_SETTINGS };
  }

  function normalizeMarkingSettings(raw) {
    const settings = createMarkingSettings();
    if (!raw || typeof raw !== 'object') return settings;
    if (MARKING_SHEET_SIZES[raw.sheet]) settings.sheet = raw.sheet;
    if (raw.orientation === 'portrait' || raw.orientation === 'landscape') {
      settings.orientation = raw.orientation;
    }
    ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].forEach((key) => {
      const value = Number(raw[key]);
      if (Number.isFinite(value)) settings[key] = clamp(Math.round(value), 0, 40);
    });
    settings.showRuler = raw.showRuler !== false;
    settings.printLegend = raw.printLegend === true;
    return settings;
  }

  function normalizeMarkings(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const result = [];
    raw.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const id = safeId(item.id) || makeId('mrk');
      if (seen.has(id)) return;
      const refId = safeText(item.refId, '', 80);
      if (!refId) return;
      seen.add(id);
      let widthMm = Number(item.widthMm);
      if (!Number.isFinite(widthMm) || widthMm < 0) widthMm = 0;
      result.push({
        id,
        kind: item.kind === 'wire' ? 'wire' : 'module',
        refId,
        textMode: ['description', 'tag', 'name'].includes(item.textMode) ? item.textMode : 'description',
        orientation: item.orientation === 'vertical' ? 'vertical' : 'horizontal',
        widthMm: Math.round(clamp(widthMm, 0, 300)),
        icon: Object.prototype.hasOwnProperty.call(MARKING_ICONS, item.icon) ? item.icon : 'none',
        color: typeof item.color === 'string' && HEX_COLOR_RE.test(item.color)
          ? item.color.toLowerCase()
          : DEFAULT_TAPE_COLOR,
        hidden: item.hidden === true,
        isCopy: item.isCopy === true,
        groupId: safeGroupId(item.groupId) || '',
        mainSnapshot: safeText(item.mainSnapshot, '', MARKING_MAIN_LENGTH),
        subSnapshot: safeText(item.subSnapshot, '', MARKING_MAIN_LENGTH),
        brandSnapshot: safeText(item.brandSnapshot, '', 60)
      });
    });
    return result;
  }

  function markingSettings() {
    return normalizeMarkingSettings(project?.markingSettings);
  }

  function markings() {
    return Array.isArray(project?.markings) ? project.markings : [];
  }

  function createMarking(kind, refId) {
    return {
      id: makeId('mrk'),
      kind,
      refId,
      textMode: 'description',
      orientation: 'horizontal',
      widthMm: 0,
      icon: 'none',
      color: DEFAULT_TAPE_COLOR,
      hidden: false,
      isCopy: false,
      groupId: '',
      mainSnapshot: '',
      subSnapshot: '',
      brandSnapshot: ''
    };
  }

  // Модули слева направо внутри рейки, рейки сверху вниз.
  function orderedModulesForMarking() {
    const ordered = [];
    project.rails.forEach((rail, railIndex) => {
      rail.modules.slice().sort((a, b) => a.slot - b.slot).forEach((module, index) => {
        ordered.push({ module, railIndex, index });
      });
    });
    return ordered;
  }

  // Синхронизация с текущей схемой: создаём недостающие наклейки, удаляем
  // «осиротевшие» и сохраняем порядок слева направо, сверху вниз.
  function syncMarkings() {
    if (!project) return markings();
    const list = markings().slice();
    const validKeys = new Set();
    const refOrder = new Map();

    orderedModulesForMarking().forEach(({ module }, index) => {
      const key = `module:${module.id}`;
      validKeys.add(key);
      refOrder.set(key, index);
      if (!list.some((item) => item.kind === 'module' && item.refId === module.id && !item.isCopy)) {
        list.push(createMarking('module', module.id));
      }
    });
    project.connections.forEach((connection, index) => {
      if (!String(connection.label || '').trim()) return;
      const key = `wire:${connection.id}`;
      validKeys.add(key);
      refOrder.set(key, 1000 + index);
      if (!list.some((item) => item.kind === 'wire' && item.refId === connection.id && !item.isCopy)) {
        list.push(createMarking('wire', connection.id));
      }
    });

    const filtered = list.filter((item) => validKeys.has(`${item.kind}:${item.refId}`));
    filtered.sort((a, b) => {
      const orderA = refOrder.get(`${a.kind}:${a.refId}`) ?? 9999;
      const orderB = refOrder.get(`${b.kind}:${b.refId}`) ?? 9999;
      if (orderA !== orderB) return orderA - orderB;
      if (a.isCopy !== b.isCopy) return a.isCopy ? 1 : -1;
      return 0;
    });

    // Группа из одной наклейки смысла не имеет — сбрасываем такую связь.
    const groupSizes = new Map();
    filtered.forEach((item) => {
      if (item.groupId) groupSizes.set(item.groupId, (groupSizes.get(item.groupId) || 0) + 1);
    });
    filtered.forEach((item) => {
      if (item.groupId && groupSizes.get(item.groupId) < 2) item.groupId = '';
    });

    const previous = markings();
    if (filtered.length !== previous.length || filtered.some((item, index) => item !== previous[index])) {
      project.markings = filtered;
    }
    return markings();
  }

  function markingMainText(marking, module, connection) {
    if (marking.isCopy && marking.mainSnapshot) return marking.mainSnapshot;
    if (marking.kind === 'wire') {
      return String(connection?.label || '').trim() || connection?.type || 'Провод';
    }
    if (marking.textMode === 'tag') return module?.tag || module?.description || module?.name || '';
    if (marking.textMode === 'name') return module?.name || module?.tag || '';
    return module?.description || module?.tag || module?.name || '';
  }

  function markingData(marking) {
    const module = marking.kind === 'module' ? moduleById(marking.refId) : null;
    const connection = marking.kind === 'wire'
      ? project.connections.find((item) => item.id === marking.refId)
      : null;
    const libraryItem = module ? LIBRARY_BY_ID.get(module.libraryId) : null;
    const orientation = marking.orientation === 'vertical' ? 'vertical' : 'horizontal';
    const widthMm = marking.widthMm > 0
      ? marking.widthMm
      : (marking.kind === 'wire' ? MARKING_WIRE_WIDTH_MM : (module?.width || 1) * MM_PER_MODULE);
    const heightMm = marking.kind === 'wire'
      ? (orientation === 'vertical' ? 16 : MARKING_WIRE_HEIGHT_MM)
      : (orientation === 'vertical' ? MARKING_STICKER_VERTICAL_HEIGHT_MM : MARKING_STICKER_HEIGHT_MM);
    return {
      main: markingMainText(marking, module, connection),
      tag: marking.kind === 'wire'
        ? (connection?.type || 'Провод')
        : (module?.tag || marking.mainSnapshot || ''),
      color: marking.kind === 'wire'
        ? (WIRE_TYPES[connection?.type]?.color || WIRE_TYPES[DEFAULT_WIRE_TYPE].color)
        : (HEX_COLOR_RE.test(String(marking.color || ''))
          ? String(marking.color).toLowerCase()
          : DEFAULT_TAPE_COLOR),
      sub: marking.isCopy && marking.subSnapshot
        ? marking.subSnapshot
        : (marking.kind === 'wire'
          ? `${connection?.type || 'Провод'} · бирка`
          : (module?.name || '')),
      brand: marking.isCopy
        ? marking.brandSnapshot
        : (libraryItem?.brand || ''),
      icon: marking.icon,
      orientation,
      widthMm,
      heightMm
    };
  }

  // Объединяем соседние наклейки с общим groupId в одну широкую.
  function markingUnits() {
    const list = syncMarkings().filter((item) => !item.hidden);
    const units = [];
    const consumed = new Set();
    list.forEach((marking, index) => {
      if (consumed.has(marking.id)) return;
      if (marking.groupId && marking.kind === 'module') {
        const members = [marking];
        for (let nextIndex = index + 1; nextIndex < list.length; nextIndex += 1) {
          const next = list[nextIndex];
          // Копии — самостоятельные наклейки: они не разрывают группу.
          if (next.isCopy) continue;
          if (next.kind !== 'module' || next.groupId !== marking.groupId) break;
          members.push(next);
          consumed.add(next.id);
        }
        if (members.length > 1) {
          const data = members.map(markingData);
          const vertical = data.some((item) => item.orientation === 'vertical');
          units.push({
            ids: members.map((item) => item.id),
            primary: marking,
            kind: 'module',
            isCopy: members.some((item) => item.isCopy),
            isGroup: true,
            main: data.map((item) => item.main).filter(Boolean).join(' / '),
            sub: data[0].sub,
            brand: data[0].brand,
            icon: data[0].icon,
            orientation: vertical ? 'vertical' : 'horizontal',
            widthMm: data.reduce((sum, item) => sum + item.widthMm, 0) +
              (members.length - 1) * MARKING_GAP_X_MM,
            heightMm: vertical ? MARKING_STICKER_VERTICAL_HEIGHT_MM : MARKING_STICKER_HEIGHT_MM
          });
          return;
        }
      }
      units.push({
        ids: [marking.id],
        primary: marking,
        kind: marking.kind,
        isCopy: marking.isCopy,
        isGroup: false,
        ...markingData(marking)
      });
    });
    return units;
  }

  // Бирки проводов не привязаны к рейке, поэтому они идут отдельным блоком
  // после рядов. Блок попадает в общий HTML обеих вкладок, но на «Ленте»
  // скрывается CSS — так раскладка остаётся единой, а отличается только
  // контейнер (см. .marking-tape и .a4-page в style.css).
  function wireTagsHtml(printMode, maxWidth = null, isPrintView = false) {
    const list = syncMarkings().filter((item) => item.kind === 'wire' && !item.hidden);
    if (!list.length) return { html: '', width: 0, height: 0 };
    const stickers = list.map((marking) => isPrintView
      ? printStickerHtml(marking, printMode)
      : markingStickerHtml({
          ids: [marking.id],
          primary: marking,
          kind: 'wire',
          isCopy: marking.isCopy,
          isGroup: false,
          ...markingData(marking),
          x: 0,
          y: 0
        }, printMode, true)).join('');
    const width = list.reduce((sum, marking) => sum + markingData(marking).widthMm, 0) +
      (list.length - 1) * MARKING_GAP_X_MM;
    const perRow = maxWidth
      ? Math.max(1, Math.floor((maxWidth + MARKING_GAP_X_MM) /
        (MARKING_WIRE_WIDTH_MM + MARKING_GAP_X_MM)))
      : list.length;
    const rows = Math.ceil(list.length / perRow);
    return {
      html: `<section class="a4-wire-tags" aria-label="Бирки проводов">
        <h3 class="a4-wire-heading">Бирки проводов · ${list.length}</h3>
        <div class="a4-wire-list">${stickers}</div>
      </section>`,
      width,
      height: 6 + rows * ((isPrintView ? PRINT_WIRE_STICKER_HEIGHT_MM : MARKING_WIRE_HEIGHT_MM) +
        MARKING_GAP_X_MM)
    };
  }

  /* ------------------ Лист 1:1: наклейки по слотам реек ----------------
     Печатный лист повторяет схему: каждая рейка из project.rails получает
     отдельный ряд с заголовком, а внутри ряда слоты идут строго слева
     направо. Занятый слот даёт наклейку шириной 18 мм × число полюсов
     модуля, пустой — невидимую заглушку ровно на 18 мм. Сам шаблон
     наклейки (sheetStickerHtml) при этом не меняется. */
  function sheetStickerUnit(marking, slots) {
    return {
      ids: [marking.id],
      primary: marking,
      kind: marking.kind,
      isCopy: marking.isCopy === true,
      isGroup: false,
      ...markingData(marking),
      // Ширина на листе всегда равна числу реальных слотов модуля.
      widthMm: Math.max(1, slots) * MM_PER_MODULE
    };
  }

  function sheetRailRows() {
    const list = syncMarkings().filter((item) =>
      item.kind === 'module' && !item.hidden);
    // Копии не занимают слот: приписываем их к рейке модуля-источника.
    const copiesByRail = new Map();
    list.forEach((marking) => {
      if (!marking.isCopy) return;
      const location = railOfModule(marking.refId);
      if (!location) return;
      if (!copiesByRail.has(location.rail.id)) copiesByRail.set(location.rail.id, []);
      copiesByRail.get(location.rail.id).push(marking);
    });

    return project.rails.map((rail, railIndex) => {
      const capacity = Math.max(0, Math.round(Number(rail.capacity) || 0));
      // Карта слотов: каждый занятый слот указывает на свой модуль.
      const owners = new Array(capacity).fill(null);
      let lastUsed = -1;
      rail.modules.forEach((module) => {
        const marking = list.find((item) => item.refId === module.id && !item.isCopy);
        if (!marking) return;
        const slot = Math.max(0, Math.round(Number(module.slot) || 0));
        const width = Math.max(1, Math.round(Number(module.width) || 1));
        for (let index = slot; index < Math.min(slot + width, capacity); index += 1) {
          owners[index] = { module, marking, slot, width };
          lastUsed = Math.max(lastUsed, index);
        }
      });

      const items = [];
      const rendered = new Set();
      // Проход по слотам 0…capacity. Хвостовые пустые слоты после последнего
      // модуля не выводятся: они не влияют на положение самих наклеек.
      for (let slot = 0; slot <= lastUsed; slot += 1) {
        const owner = owners[slot];
        if (!owner) {
          // Пустое место — невидимая заглушка шириной ровно 1 модуль (18 мм).
          items.push({ type: 'spacer', slots: 1, widthMm: MM_PER_MODULE });
          continue;
        }
        if (rendered.has(owner.module.id)) continue; // модуль занял несколько слотов
        rendered.add(owner.module.id);

        // Соседние модули с общим groupId дают одну широкую наклейку.
        const members = [owner];
        if (owner.marking.groupId) {
          let nextSlot = slot + owner.width;
          while (nextSlot <= lastUsed) {
            const candidate = owners[nextSlot];
            if (!candidate || candidate.marking.isCopy ||
                candidate.marking.groupId !== owner.marking.groupId) break;
            members.push(candidate);
            rendered.add(candidate.module.id);
            nextSlot += candidate.width;
          }
        }

        if (members.length > 1) {
          const data = members.map((entry) => markingData(entry.marking));
          const slots = members.reduce((sum, entry) => sum + entry.width, 0);
          items.push({
            type: 'module',
            slots,
            widthMm: slots * MM_PER_MODULE,
            unit: {
              ids: members.map((entry) => entry.marking.id),
              primary: owner.marking,
              kind: 'module',
              isCopy: members.some((entry) => entry.marking.isCopy),
              isGroup: true,
              main: data.map((item) => item.main).filter(Boolean).join(' / '),
              tag: data[0].tag,
              sub: data[0].sub,
              brand: data[0].brand,
              icon: data[0].icon,
              color: data[0].color
            }
          });
        } else {
          items.push({
            type: 'module',
            slots: owner.width,
            widthMm: owner.width * MM_PER_MODULE,
            unit: sheetStickerUnit(owner.marking, owner.width)
          });
        }
      }

      (copiesByRail.get(rail.id) || []).forEach((marking) => {
        const module = moduleById(marking.refId);
        const slots = Math.max(1, Math.round(Number(module?.width) || 1));
        items.push({
          type: 'module',
          slots,
          widthMm: slots * MM_PER_MODULE,
          unit: sheetStickerUnit(marking, slots)
        });
      });

      return {
        rail,
        railIndex,
        label: `Рейка ${railIndex + 1}`,
        items,
        width: items.reduce((sum, item) => sum + item.widthMm, 0),
        moduleCount: items.filter((item) => item.type === 'module').length
      };
    });
  }

  // Слишком длинный ряд (шире листа) делится на продолжения, как на ленте.
  // Части сохраняют порядок слотов и точную ширину 18 мм на модуль.
  function splitSheetRow(row, maxWidth) {
    if (!maxWidth || row.width <= maxWidth) return [{ ...row, continuation: false }];
    const chunks = [];
    let items = [];
    let width = 0;
    row.items.forEach((item) => {
      if (items.length && width + item.widthMm > maxWidth) {
        chunks.push({ items, width });
        items = [];
        width = 0;
      }
      items.push(item);
      width += item.widthMm;
    });
    if (items.length) chunks.push({ items, width });
    if (!chunks.length) return [{ ...row, continuation: false }];
    return chunks.map((chunk, index) => ({
      ...row,
      items: chunk.items,
      width: chunk.width,
      continuation: index > 0
    }));
  }

  // Один ряд рейки на печатном листе: заголовок и полоса, где наклейки и
  // заглушки идут строго друг за другом без переноса внутри рейки.
  function sheetRailRowHtml(row, printMode) {
    const cells = row.items.map((item) => item.type === 'spacer'
      ? `<span class="sheet-spacer" style="--slot-width:${item.widthMm}mm" aria-hidden="true"></span>`
      : sheetStickerHtml(item.unit, printMode)).join('');
    return `<section class="sheet-rail-row" data-rail-index="${row.railIndex}">` +
      `<div class="sheet-rail-heading">` +
        `<span class="sheet-rail-name">${escapeHtml(row.label)}</span>` +
        `<span class="sheet-rail-meta">${row.moduleCount} ` +
          `${plural(row.moduleCount, ['модуль', 'модуля', 'модулей'])} · ${row.rail.capacity} P</span>` +
        (row.continuation ? `<span class="sheet-continuation">Продолжение рейки</span>` : '') +
      `</div>` +
      `<div class="sheet-rail-track">` +
        (cells || `<span class="sheet-spacer" style="--slot-width:18mm" aria-hidden="true"></span>`) +
      `</div>` +
    `</section>`;
  }

  function sheetStickerHtml(item, printMode) {
    const isWire = item.kind === 'wire';
    // Ширина строго из расчёта 18 мм на модуль. Для бирок проводов (24 мм)
    // получается дробный коэффициент — их физический размер не меняется.
    const moduleWidth = Math.max(1, item.widthMm || MM_PER_MODULE) / MM_PER_MODULE;
    const classes = ['print-sticker'];
    if (isWire) classes.push('is-wire');
    if (item.isGroup) classes.push('is-group');
    if (item.isCopy) classes.push('is-copy');
    const iconKey = item.icon && MARKING_ICONS[item.icon]?.svg ? item.icon : 'breaker';
    const icon = isWire ? '' :
      `<span class="print-sticker-icon" aria-hidden="true">` +
        `<svg viewBox="0 0 24 24">${MARKING_ICONS[iconKey].svg}</svg></span>`;
    const tag = String(item.tag || '').trim() || (isWire ? 'Провод' : '—');
    const desc = isWire
      ? (String(item.main || '').trim() || String(item.sub || '').trim())
      : String(item.sub || '').trim();
    const brand = String(item.brand || '').trim();
    const color = HEX_COLOR_RE.test(String(item.color || ''))
      ? String(item.color).toLowerCase()
      : DEFAULT_TAPE_COLOR;
    const attrs = printMode
      ? ''
      : ` type="button" data-marking-id="${escapeHtml(item.primary.id)}" ` +
        `title="${escapeHtml(`${tag} · ${desc || 'Наклейка'} — клик для редактирования`)}"`;
    const tagName = printMode ? 'div' : 'button';
    return `<${tagName} class="${classes.join(' ')}" ` +
      `style="--module-width:${moduleWidth.toFixed(4)};--sticker-color:${escapeHtml(color)}"${attrs}>` +
        icon +
        `<span class="print-sticker-copy">` +
          `<span class="print-sticker-tag">${escapeHtml(tag)}</span>` +
          `<span class="print-sticker-desc">${escapeHtml(desc)}</span>` +
          `<span class="print-sticker-meta">${escapeHtml(brand)}</span>` +
        `</span>` +
        `<span class="print-sticker-color" aria-hidden="true"></span>` +
      `</${tagName}>`;
  }

  // «Лист 1:1» — фиксированный A4 альбомный лист без полей страницы.
  // Это единственный способ гарантировать 1:1 и в предпросмотре, и в печати:
  // остальные настройки листа относятся только к «Ленте».
  function sheetPageSettings() {
    const settings = markingSettings();
    return {
      ...settings,
      sheet: 'A4',
      orientation: 'landscape',
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0
    };
  }

  // Высота одного блока в печатном потоке. Ряд рейки состоит из заголовка
  // и полосы наклеек; если ряд пришлось масштабировать, высота уменьшается.
  function markingPartHeightMm(part) {
    if (part.type === 'wires') return part.height || MARKING_WIRE_HEIGHT_MM + 8;
    return TAPE_RAIL_HEADING_MM + TAPE_CELL_HEIGHT_MM * (part.scale || 1);
  }

  function buildSheetPages(printMode) {
    const settings = sheetPageSettings();
    const sizes = MARKING_SHEET_SIZES[settings.sheet] || MARKING_SHEET_SIZES.A4;
    const [sheetW, sheetH] = sizes[settings.orientation];
    const contentW = Math.max(20, sheetW - settings.marginLeft - settings.marginRight);
    // Внизу листа всегда остаётся место под контрольный маркер 100 мм,
    // а при включённой легенде — ещё и под её список.
    const legendEntries = settings.printLegend ? markingLegendEntries() : [];
    const legendH = markingLegendHeightMm(legendEntries);
    const rulerH = settings.showRuler ? MARKING_RULER_HEIGHT_MM : 0;
    const footerH = MARKING_SCALE_MARKER_HEIGHT_MM + (legendEntries.length ? legendH + 1 : 0);
    const contentH = Math.max(20, sheetH - settings.marginTop - settings.marginBottom - rulerH - footerH);

    // По одному ряду на рейку. Наклейки внутри ряда не переносятся; если
    // рейка шире листа, она делится на продолжения с сохранением слотов.
    const parts = [];
    sheetRailRows().forEach((row) => {
      splitSheetRow(row, contentW).forEach((part) => parts.push(part));
    });

    const rowHeight = SHEET_RAIL_HEADING_MM + PRINT_STICKER_HEIGHT_MM;
    const rowStep = rowHeight + SHEET_RAIL_GAP_MM;
    const rowsPerPage = Math.max(1, Math.floor((contentH + SHEET_RAIL_GAP_MM) / rowStep));
    const pages = [];
    for (let start = 0; start < parts.length; start += rowsPerPage) {
      pages.push({
        html: parts.slice(start, start + rowsPerPage)
          .map((part) => sheetRailRowHtml(part, printMode)).join('')
      });
    }
    if (!pages.length) pages.push({ html: '' });

    // Бирки проводов не привязаны к рейке — отдельный блок после рядов.
    const wires = wireTagsHtml(printMode, contentW, true);
    if (wires.html) pages[pages.length - 1].html += wires.html;

    return {
      pages,
      settings,
      sheetW,
      sheetH,
      contentW,
      contentH,
      legendEntries
    };
  }

  // Уникальные значки, выбранные у модулей на схеме. Легенда строится
  // именно по наклейкам модулей: бирки проводов и модули без иконки
  // в неё не попадают.
  function markingLegendEntries() {
    const seen = new Set();
    const entries = [];
    markings().forEach((marking) => {
      if (marking.kind !== 'module' || marking.icon === 'none') return;
      const icon = MARKING_ICONS[marking.icon];
      if (!icon || !icon.svg || seen.has(marking.icon)) return;
      seen.add(marking.icon);
      entries.push({ key: marking.icon, label: icon.label, svg: icon.svg });
    });
    return entries;
  }

  function markingLegendHeightMm(entries) {
    if (!entries.length) return 0;
    const rows = Math.ceil(entries.length / MARKING_LEGEND_COLUMNS);
    return MARKING_LEGEND_HEADER_MM + rows * MARKING_LEGEND_ROW_MM;
  }

  function markingLegendHtml(entries) {
    if (!entries.length) return '';
    const items = entries.map((entry) => `
      <li class="marking-legend-item">
        <span class="marking-legend-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${entry.svg}</svg></span>
        <span class="marking-legend-name">— ${escapeHtml(entry.label)}</span>
      </li>`).join('');
    return `<div class="marking-legend" role="group" aria-label="Легенда значков">
      <div class="marking-legend-title">Легенда</div>
      <ul class="marking-legend-list">${items}</ul>
    </div>`;
  }

  // Контрольный размер: линия ровно 100 мм (см. .marking-scale-marker-line
  // в style.css). Добавляется на каждый печатный лист под наклейками.
  function markingScaleMarkerHtml() {
    return `<div class="marking-scale-marker" role="img"
      aria-label="Контрольный размер: 100 мм. Приложите линейку к экрану или бумаге для проверки масштаба">
      <span class="marking-scale-marker-line"></span>
      <span class="marking-scale-marker-text">Контрольный размер: 100 мм. Приложите линейку к экрану/бумаге для проверки масштаба</span>
    </div>`;
  }

  function markingRulerHtml() {
    return `<div class="marking-ruler" role="img" aria-label="Контрольная линейка длиной 100 мм">
      <span class="marking-ruler-bar"></span>
      <span class="marking-ruler-label">0 — 100 мм</span>
      <span class="marking-ruler-note">масштаб 1:1 · проверьте перед печатью</span>
    </div>`;
  }

  function markingStickerHtml(sticker, printMode, flow = false) {
    const classes = ['marking-sticker'];
    if (sticker.kind === 'wire') classes.push('is-wire');
    if (sticker.isCopy) classes.push('is-copy');
    if (sticker.isGroup) classes.push('is-group');
    if (sticker.kind === 'module' && sticker.widthMm > MM_PER_MODULE) classes.push('is-wide');
    if (sticker.orientation === 'vertical') classes.push('is-vertical');
    // Бирки проводов идут обычным потоком внизу листа, а не в абсолютной
    // раскладке — поэтому для них не задаём left/top.
    if (flow) classes.push('is-flow');
    if (!printMode && selectedMarkingId && sticker.ids.includes(selectedMarkingId)) {
      classes.push('is-selected');
    }
    const style = flow
      ? `width:${sticker.widthMm}mm;height:${sticker.heightMm}mm`
      : `left:${sticker.x}mm;top:${sticker.y}mm;width:${sticker.widthMm}mm;height:${sticker.heightMm}mm`;
    const icon = MARKING_ICONS[sticker.icon]?.svg
      ? `<span class="sticker-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${MARKING_ICONS[sticker.icon].svg}</svg></span>`
      : '';
    const copy = `<span class="sticker-copy">
      <span class="sticker-main">${escapeHtml(sticker.main || '')}</span>
      ${sticker.sub ? `<span class="sticker-sub">${escapeHtml(sticker.sub)}</span>` : ''}
      ${sticker.brand ? `<span class="sticker-brand">${escapeHtml(sticker.brand)}</span>` : ''}
    </span>`;
    if (printMode) {
      return `<div class="${classes.join(' ')}" style="${style}">${icon}${copy}</div>`;
    }
    const title = `${sticker.main || 'Наклейка'}${sticker.sub ? ' · ' + sticker.sub : ''} — клик для редактирования`;
    return `<button type="button" class="${classes.join(' ')}" style="${style}"
      data-marking-id="${escapeHtml(sticker.primary.id)}" title="${escapeHtml(title)}">${icon}${copy}</button>`;
  }

  // Физический лист А4: белый фон, чёрный текст, реальные миллиметры.
  // Отступы применяются именно к этому контейнеру (padding), а не к @page —
  // поэтому на экране и в печати получается один и тот же лист 1:1.
  function markingSheetHtml(page, index, total, layout, printMode) {
    const settings = layout.settings;
    const vars = [
      `--sheet-w:${layout.sheetW}mm`,
      `--sheet-h:${layout.sheetH}mm`,
      `--pad-top:${settings.marginTop}mm`,
      `--pad-right:${settings.marginRight}mm`,
      `--pad-bottom:${settings.marginBottom}mm`,
      `--pad-left:${settings.marginLeft}mm`,
      `--marker-h:${MARKING_SCALE_MARKER_HEIGHT_MM}mm`,
      `--legend-h:${markingLegendHeightMm(layout.legendEntries)}mm`
    ].join(';');
    return `<div class="a4-page" style="${vars}">
      <div class="a4-page-inner">
        ${settings.showRuler ? markingRulerHtml() : ''}
        <div class="a4-rows">
          ${page.html || '<p class="a4-empty">На этой странице нет наклеек</p>'}
        </div>
        <div class="a4-footer">
          ${markingLegendHtml(layout.legendEntries)}
          ${markingScaleMarkerHtml()}
        </div>
      </div>
      ${printMode ? '' : `<span class="a4-page-label">Страница ${index + 1} из ${total}</span>`}
    </div>`;
  }

  // @page не задаётся инлайном в разметке, поэтому правило генерируется
  // динамически. Оно идёт после style.css, а значит переопределяет настройки A4
  // по умолчанию для журнала.
  function updateMarkingPageStyle(context) {
    if (!dom.markingPageStyle) return;
    if (context !== 'marking') {
      dom.markingPageStyle.textContent = '';
      return;
    }
    // Жёстко задаём A4 альбомную ориентацию и нулевые поля страницы.
    // Любые ненулевые поля заставят браузер «подогнать» содержимое и
    // нарушат масштаб 1:1 (1 модуль = 18 мм, контрольная линия = 100 мм).
    dom.markingPageStyle.textContent = '@page { size: A4 landscape; margin: 0; }';
  }

  function syncMarkingSettingsUI() {
    // На листе 1:1 размер и поля страницы фиксированы (A4 landscape, 0 мм).
    const settings = dom.markingView?.dataset.mode === 'sheet'
      ? sheetPageSettings()
      : markingSettings();
    const fields = {
      sheet: dom.markingSize,
      orientation: dom.markingOrientation,
      marginTop: dom.markingMarginTop,
      marginRight: dom.markingMarginRight,
      marginBottom: dom.markingMarginBottom,
      marginLeft: dom.markingMarginLeft
    };
    Object.entries(fields).forEach(([key, input]) => {
      if (input && document.activeElement !== input) input.value = String(settings[key]);
    });
    if (dom.markingRulerToggle) dom.markingRulerToggle.checked = settings.showRuler;
    if (dom.markingRulerState) dom.markingRulerState.textContent = settings.showRuler ? 'Вкл' : 'Выкл';
    if (dom.markingPrintLegend) dom.markingPrintLegend.checked = settings.printLegend;
    if (dom.markingPrintLegendState) {
      dom.markingPrintLegendState.textContent = settings.printLegend ? 'Вкл' : 'Выкл';
    }
  }

  function renderMarking() {
    if (!project) return null;
    syncMarkings();
    syncMarkingSettingsUI();
    const layout = buildSheetPages(false);
    const printLayout = buildSheetPages(true);
    const screenHtml = layout.pages
      .map((page, index) => markingSheetHtml(page, index, layout.pages.length, layout, false))
      .join('');
    const printHtml = printLayout.pages
      .map((page, index) => markingSheetHtml(page, index, printLayout.pages.length, printLayout, true))
      .join('');
    if (dom.markingSheetArea) dom.markingSheetArea.innerHTML = screenHtml;
    if (dom.markingPrintSheet) dom.markingPrintSheet.innerHTML = printHtml;

    const units = markingUnits();
    const moduleCount = units.filter((unit) => unit.kind === 'module').length;
    const wireCount = units.filter((unit) => unit.kind === 'wire').length;
    if (dom.markingSubtitle) {
      dom.markingSubtitle.textContent =
        `${project.name} · ${moduleCount} ${plural(moduleCount, ['наклейка', 'наклейки', 'наклеек'])}` +
        `${wireCount ? ` · ${wireCount} ${plural(wireCount, ['бирка', 'бирки', 'бирок'])}` : ''}` +
        ` · ${layout.pages.length} ${plural(layout.pages.length, ['лист', 'листа', 'листов'])}` +
        ` · ${settingsOrientationLabel(layout.settings)}`;
    }
    updateMarkingPageStyle(printContext === 'marking' ? 'marking' : null);
    // Лента редактора строится из тех же наклеек, что и печатный лист.
    renderTape();
    if (dom.markingEditor && !dom.markingEditor.hidden) positionMarkingEditor();
    return layout;
  }

  function settingsOrientationLabel(settings) {
    return `${settings.sheet}, ${settings.orientation === 'portrait' ? 'портрет' : 'ландшафт'}`;
  }

  function onMarkingSettingChange() {
    const settings = markingSettings();
    if (dom.markingSize) settings.sheet = dom.markingSize.value;
    if (dom.markingOrientation) settings.orientation = dom.markingOrientation.value;
    const margins = [
      [dom.markingMarginTop, 'marginTop'],
      [dom.markingMarginRight, 'marginRight'],
      [dom.markingMarginBottom, 'marginBottom'],
      [dom.markingMarginLeft, 'marginLeft']
    ];
    margins.forEach(([input, key]) => {
      const value = Number(input?.value);
      if (input && Number.isFinite(value)) settings[key] = clamp(Math.round(value), 0, 40);
    });
    if (dom.markingRulerToggle) settings.showRuler = dom.markingRulerToggle.checked;
    if (dom.markingPrintLegend) settings.printLegend = dom.markingPrintLegend.checked;
    project.markingSettings = settings;
    persistProject();
    commitHistory();
    renderMarking();
  }

  function resolveMarkingAnchor() {
    if (!markingEditorAnchor) return null;
    if (markingEditorAnchor.type === 'module') {
      return dom.moduleLayer?.querySelector(`[data-module-id="${markingEditorAnchor.id}"]`) || null;
    }
    if (!dom.markingSheetArea) return null;
    const items = dom.markingSheetArea.querySelectorAll('[data-marking-id]');
    return Array.from(items).find((item) => item.dataset.markingId === markingEditorAnchor.id) || null;
  }

  function positionMarkingEditor() {
    const panel = dom.markingEditor;
    const anchor = resolveMarkingAnchor();
    if (!panel || panel.hidden || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = panel.offsetWidth || 326;
    const height = panel.offsetHeight || 520;
    let left = rect.right + 12;
    if (left + width > window.innerWidth - 8) left = rect.left - width - 12;
    if (left < 8) left = clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8));
    let top = rect.top - 10;
    if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
    if (top < 8) top = 8;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function highlightSelectedSticker() {
    if (!dom.markingSheetArea) return;
    dom.markingSheetArea.querySelectorAll('[data-marking-id]').forEach((element) => {
      element.classList.toggle('is-selected', element.dataset.markingId === selectedMarkingId);
    });
  }

  function markingIconPickerHtml() {
    return Object.entries(MARKING_ICONS).map(([key, icon]) => `
      <button class="marking-icon-option" type="button" data-icon="${escapeHtml(key)}"
              title="${escapeHtml(icon.label)}" aria-label="${escapeHtml(icon.label)}"
              aria-pressed="false">${icon.svg
                ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.svg}</svg>`
                : '<span aria-hidden="true">—</span>'}</button>`).join('');
  }

  function fillMarkingEditor(marking) {
    if (!marking || !dom.markingEditor) return;
    const data = markingData(marking);
    const module = marking.kind === 'module' ? moduleById(marking.refId) : null;
    if (dom.markingEditorTitle) {
      dom.markingEditorTitle.textContent = marking.kind === 'wire'
        ? 'Бирка провода'
        : (marking.isGroup ? 'Группа наклеек' : (marking.isCopy ? 'Копия наклейки' : 'Наклейка модуля'));
    }
    if (dom.markingMainInput) dom.markingMainInput.value = data.main;
    if (dom.markingTextMode) dom.markingTextMode.value = marking.textMode;
    if (dom.markingTextMode) dom.markingTextMode.disabled = marking.kind === 'wire' || marking.isCopy;
    if (dom.markingTextOrientation) dom.markingTextOrientation.value = marking.orientation;
    if (dom.markingWidthMm) dom.markingWidthMm.value = String(marking.widthMm || data.widthMm);
    if (dom.markingPreset) {
      const preset = marking.widthMm || ([18, 36, 54, 72, 108].includes(data.widthMm) ? data.widthMm : 0);
      dom.markingPreset.value = String(preset);
    }
    if (dom.markingIconPicker) {
      dom.markingIconPicker.querySelectorAll('[data-icon]').forEach((button) => {
        const active = button.dataset.icon === marking.icon;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    if (dom.markingGroup) {
      dom.markingGroup.textContent = marking.groupId ? 'Разгруппировать' : 'Сгруппировать';
      dom.markingGroup.disabled = marking.kind === 'wire' || marking.isCopy;
    }
    if (dom.markingEditorMeta) {
      const parts = [
        `Реальный размер: ${data.widthMm} × ${data.heightMm} мм`,
        data.sub,
        data.brand ? `Бренд: ${data.brand}` : '',
        module ? `Модуль: ${module.tag || '—'}` : ''
      ].filter(Boolean);
      dom.markingEditorMeta.textContent = parts.join(' · ');
    }
  }

  function openMarkingEditor(markingId, anchor) {
    const marking = markings().find((item) => item.id === markingId);
    if (!marking || !dom.markingEditor) return;
    selectedMarkingId = markingId;
    // Якорь может быть как DOM-элементом (клик по наклейке/модулю), так и
    // готовым описанием { type, id } (после клонирования и вставки).
    if (anchor && anchor.nodeType === 1) {
      markingEditorAnchor = anchor.hasAttribute?.('data-module-id')
        ? { type: 'module', id: anchor.getAttribute('data-module-id') }
        : { type: 'sticker', id: markingId };
    } else {
      markingEditorAnchor = anchor || { type: 'sticker', id: markingId };
    }
    fillMarkingEditor(marking);
    dom.markingEditor.hidden = false;
    highlightSelectedSticker();
    positionMarkingEditor();
  }

  function closeMarkingEditor() {
    if (dom.markingEditor) dom.markingEditor.hidden = true;
    selectedMarkingId = null;
    markingEditorAnchor = null;
    highlightSelectedSticker();
  }

  function commitMarkingChange(message, fullRender = false) {
    syncMarkings();
    persistProject();
    commitHistory();
    if (fullRender) renderAll();
    else renderMarking();
    if (message) showToast(message, 'success', 1800);
  }

  function updateMarkingFromEditor(render = true) {
    const marking = markings().find((item) => item.id === selectedMarkingId);
    if (!marking || !dom.markingEditor) return;
    const text = String(dom.markingMainInput?.value || '').trim().slice(0, MARKING_MAIN_LENGTH);
    const orientation = dom.markingTextOrientation?.value === 'vertical' ? 'vertical' : 'horizontal';
    const width = Number(dom.markingWidthMm?.value);
    marking.orientation = orientation;
    marking.widthMm = Number.isFinite(width) && width > 0
      ? Math.round(clamp(width, 6, 300))
      : 0;
    marking.icon = MARKING_ICONS[dom.markingIconPicker?.querySelector('.marking-icon-option.is-active')?.dataset.icon]
      ? dom.markingIconPicker.querySelector('.marking-icon-option.is-active').dataset.icon
      : 'none';

    if (marking.kind === 'wire') {
      const connection = project.connections.find((item) => item.id === marking.refId);
      if (connection && !marking.isCopy) connection.label = text;
      else marking.mainSnapshot = text;
    } else if (marking.isCopy) {
      marking.mainSnapshot = text;
    } else if (marking.textMode === 'tag') {
      const module = moduleById(marking.refId);
      if (module) module.tag = text.slice(0, 10).toUpperCase() || module.tag;
    } else if (marking.textMode === 'name') {
      const module = moduleById(marking.refId);
      if (module) module.name = text.slice(0, MAX_MODULE_NAME_LENGTH) || module.name;
    } else {
      const module = moduleById(marking.refId);
      if (module) module.description = text;
    }
    if (render) commitMarkingChange('Наклейка обновлена', true);
  }

  function cloneMarking(markingId = selectedMarkingId) {
    const source = markings().find((item) => item.id === markingId);
    if (!source) return;
    const data = markingData(source);
    const copy = {
      ...JSON.parse(JSON.stringify(source)),
      id: makeId('mrk'),
      hidden: false,
      isCopy: true,
      groupId: '',
      mainSnapshot: data.main,
      subSnapshot: data.sub,
      brandSnapshot: data.brand
    };
    const index = markings().findIndex((item) => item.id === source.id);
    project.markings.splice(index + 1, 0, copy);
    selectedMarkingId = copy.id;
    markingEditorAnchor = { type: 'sticker', id: copy.id };
    commitMarkingChange('Наклейка склонирована');
    fillMarkingEditor(copy);
  }

  function deleteMarking(markingId = selectedMarkingId) {
    const marking = markings().find((item) => item.id === markingId);
    if (!marking) return;
    if (marking.isCopy) {
      project.markings = markings().filter((item) => item.id !== marking.id);
      // Копии с общим groupId больше нет — группа распадается.
    } else {
      marking.hidden = true;
    }
    closeMarkingEditor();
    commitMarkingChange('Наклейка удалена с листа');
  }

  function toggleMarkingGroup(markingId = selectedMarkingId) {
    const marking = markings().find((item) => item.id === markingId);
    if (!marking || marking.kind === 'wire' || marking.isCopy) return;
    if (marking.groupId) {
      const groupId = marking.groupId;
      markings().forEach((item) => {
        if (item.groupId === groupId) item.groupId = '';
      });
      commitMarkingChange('Группа разъединена');
      fillMarkingEditor(marking);
      return;
    }
    const list = syncMarkings();
    const index = list.findIndex((item) => item.id === marking.id);
    const neighbor = list.slice(index + 1).find((item) =>
      item.kind === 'module' && !item.isCopy && !item.hidden && !item.groupId);
    if (!neighbor) {
      showToast('Справа нет свободной наклейки для объединения', 'error', 2400);
      return;
    }
    const groupId = makeId('grp');
    marking.groupId = groupId;
    neighbor.groupId = groupId;
    commitMarkingChange('Наклейки объединены');
    fillMarkingEditor(marking);
  }

  function copyMarkingToClipboard() {
    const marking = markings().find((item) => item.id === selectedMarkingId);
    if (!marking) {
      showToast('Выберите наклейку для копирования', 'error', 2200);
      return;
    }
    const data = markingData(marking);
    markingClipboard = {
      ...JSON.parse(JSON.stringify(marking)),
      mainSnapshot: data.main,
      subSnapshot: data.sub,
      brandSnapshot: data.brand
    };
    showToast('Наклейка скопирована · Ctrl+V — вставить', 'success', 1800);
  }

  function pasteMarkingFromClipboard() {
    if (!markingClipboard) {
      showToast('Буфер наклеек пуст — сначала Ctrl+C', 'error', 2200);
      return;
    }
    const copy = {
      ...JSON.parse(JSON.stringify(markingClipboard)),
      id: makeId('mrk'),
      hidden: false,
      isCopy: true,
      groupId: ''
    };
    const anchor = markings().find((item) => item.id === selectedMarkingId);
    const index = anchor ? markings().findIndex((item) => item.id === anchor.id) : markings().length - 1;
    project.markings.splice(index + 1, 0, copy);
    selectedMarkingId = copy.id;
    markingEditorAnchor = { type: 'sticker', id: copy.id };
    commitMarkingChange('Наклейка вставлена');
    fillMarkingEditor(copy);
  }

  function autoNumberMarkings() {
    syncMarkings();
    const counters = new Map();
    orderedModulesForMarking().forEach(({ module }) => {
      const prefixRaw = LIBRARY_BY_ID.get(module.libraryId)?.tagPrefix || 'QF';
      const prefix = /^[A-Za-zА-Яа-я]{1,4}$/u.test(prefixRaw) ? prefixRaw.toUpperCase() : 'QF';
      const number = (counters.get(prefix) || 0) + 1;
      counters.set(prefix, number);
      module.tag = `${prefix}${number}`;
      const marking = markings().find((item) =>
        item.kind === 'module' && item.refId === module.id && !item.isCopy);
      if (marking) marking.textMode = 'tag';
    });
    markings().filter((item) => item.isCopy && item.kind === 'module').forEach((copy) => {
      const module = moduleById(copy.refId);
      if (!module) return;
      copy.mainSnapshot = copy.textMode === 'tag'
        ? module.tag
        : (copy.textMode === 'name' ? module.name : (module.description || module.tag));
    });
    commitMarkingChange('Теги присвоены по порядку слева направо', true);
    if (!dom.markingEditor.hidden && selectedMarkingId) {
      fillMarkingEditor(markings().find((item) => item.id === selectedMarkingId));
    }
  }

  function resetMarkings() {
    project.markings = [];
    project.markingSettings = createMarkingSettings();
    closeMarkingEditor();
    markingClipboard = null;
    commitMarkingChange('Маркировка сгенерирована заново', true);
  }

  function exportMarkingJson() {
    const settings = markingSettings();
    const labels = syncMarkings().map((marking) => {
      const data = markingData(marking);
      return {
        id: marking.id,
        kind: marking.kind,
        refId: marking.refId,
        main: data.main,
        sub: data.sub,
        brand: data.brand,
        orientation: marking.orientation,
        widthMm: data.widthMm,
        icon: marking.icon,
        color: marking.color,
        groupId: marking.groupId,
        hidden: marking.hidden,
        isCopy: marking.isCopy
      };
    });
    const payload = {
      format: 'shchit-studio-marking',
      schemaVersion: 1,
      project: project?.name || 'Новый щит',
      createdAt: new Date().toISOString(),
      settings,
      labels
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `marking-${safeFileName(project?.name)}-${fileDate()}.json`);
    showToast('Маркировка экспортирована в JSON', 'success', 2600);
  }

  /* ====================================================================
     РЕДАКТОР ЛЕНТЫ — ячейки на DIN-рейке, масштаб 1:1
     ==================================================================== */

  // Значок назначения в ячейке: SVG-пиктограмма (печатается чётко).
  function tapeIconHtml(iconKey, className) {
    const icon = MARKING_ICONS[iconKey];
    if (!icon || iconKey === 'none') return '';
    if (icon.svg) {
      return `<span class="${className}" aria-hidden="true"><svg viewBox="0 0 24 24">${icon.svg}</svg></span>`;
    }
    return icon.emoji
      ? `<span class="${className}" aria-hidden="true">${escapeHtml(icon.emoji)}</span>`
      : '';
  }

  // Текст зоны 1: бренд, модель и номинал устройства.
  function tapeTitleFor(marking) {
    const module = marking?.kind === 'module' ? moduleById(marking.refId) : null;
    const libraryItem = module ? LIBRARY_BY_ID.get(module.libraryId) : null;
    const brand = module?.brand || libraryItem?.brand || MODULE_BRANDS[module?.type] || '';
    const model = libraryItem?.sku || module?.sku || module?.name || '';
    const name = String(module?.name || '');
    const poles = name.match(/\b([1-6])P\b/i);
    const rating = name.match(/\b(C\s?\d{1,3}|\d{1,3}\s?A)\b/i);
    const meta = [poles ? `${poles[1]}P` : '', rating ? rating[1].replace(/\s+/g, '') : '']
      .filter(Boolean).join(' · ') || libraryItem?.typeLabel || module?.type || '';
    return { brand, model, meta };
  }

  function tapeDescriptionFor(marking) {
    const module = marking?.kind === 'module' ? moduleById(marking.refId) : null;
    if (!module) return '';
    const description = String(module.description || '').trim();
    if (description) return description;
    const libraryItem = LIBRARY_BY_ID.get(module.libraryId);
    return libraryItem?.typeLabel || module.type || 'Модуль';
  }

  // Ширина наклейки в ленте равна реальной ширине модуля на рейке:
  // 1P = 18 мм, 3P = 54 мм. Пользовательская ширина из «Листа 1:1» сюда
  // не попадает — иначе наклейки перестанут совпадать со слотами рейки.
  function tapeWidthFor(marking) {
    const module = marking?.kind === 'module' ? moduleById(marking.refId) : null;
    if (!module) return markingData(marking).widthMm;
    return Math.max(1, Math.round(Number(module.width) || 1)) * MM_PER_MODULE;
  }

  // Раскладка по DIN-рейкам: для каждой рейки — свой ряд. Модули сортируются
  // по slot, а пропущенные слоты между ними заполняются заглушками шириной
  // 18 мм за слот. Благодаря этому наклейки физически повторяют рейку.
  function tapeLayout() {
    const list = syncMarkings().filter((item) =>
      item.kind === 'module' && !item.hidden);
    // Копии наклеек не занимают слот — приписываем их к рейке модуля-источника.
    const copiesByRail = new Map();
    list.forEach((marking) => {
      if (!marking.isCopy) return;
      const location = railOfModule(marking.refId);
      if (!location) return;
      if (!copiesByRail.has(location.rail.id)) copiesByRail.set(location.rail.id, []);
      copiesByRail.get(location.rail.id).push(marking);
    });

    const rows = project.rails.map((rail, railIndex) => {
      const modules = rail.modules
        .map((module) => ({
          module,
          marking: list.find((item) => item.refId === module.id && !item.isCopy) || null,
          slot: Math.max(0, Math.round(Number(module.slot) || 0)),
          width: Math.max(1, Math.round(Number(module.width) || 1))
        }))
        .filter((entry) => entry.marking)
        .sort((a, b) => a.slot - b.slot);

      // Объединяем только соседние модули внутри одной рейки.
      const blocks = [];
      for (let index = 0; index < modules.length;) {
        const entry = modules[index];
        if (entry.marking.groupId) {
          const members = [entry];
          let next = index + 1;
          while (next < modules.length &&
                 modules[next].marking.groupId === entry.marking.groupId &&
                 !modules[next].marking.isCopy) {
            members.push(modules[next]);
            next += 1;
          }
          if (members.length > 1) {
            blocks.push({
              marking: entry.marking,
              members: members.map((item) => item.marking),
              startSlot: members[0].slot,
              slots: members.reduce((sum, item) => sum + item.width, 0)
            });
            index = next;
            continue;
          }
        }
        blocks.push({
          marking: entry.marking,
          members: [entry.marking],
          startSlot: entry.slot,
          slots: entry.width
        });
        index += 1;
      }

      const items = [];
      let left = 0;
      let occupiedUntil = 0; // первый свободный слот после предыдущего блока
      blocks.forEach((block) => {
        // Заглушка перед блоком: и до первого модуля, и между модулями.
        if (block.startSlot > occupiedUntil) {
          const slots = block.startSlot - occupiedUntil;
          const width = slots * MM_PER_MODULE;
          items.push({ type: 'spacer', left, width, slots });
          left += width;
        }
        const width = block.members.reduce((sum, marking) => sum + tapeWidthFor(marking), 0);
        items.push({
          type: 'module',
          marking: block.marking,
          members: block.members,
          left,
          width,
          slots: block.slots,
          groupText: tapeDescriptionFor(block.marking)
        });
        left += width;
        occupiedUntil = block.startSlot + block.slots;
      });

      (copiesByRail.get(rail.id) || []).forEach((marking) => {
        const width = tapeWidthFor(marking);
        items.push({ type: 'module', marking, members: [marking], left, width, slots: 0, groupText: '' });
        left += width;
      });

      return {
        rail,
        railIndex,
        label: `Рейка ${railIndex + 1}`,
        items,
        total: left,
        moduleCount: items.filter((item) => item.type === 'module').length
      };
    });

    return { rows, total: rows.reduce((max, row) => Math.max(max, row.total), 0) };
  }

  // Обратная совместимость: все печатные пути используют единый компактный
  // горизонтальный шаблон наклейки листа 1:1 (см. sheetStickerHtml).
  function printStickerHtml(marking, printMode) {
    return sheetStickerHtml({
      ids: [marking.id],
      primary: marking,
      kind: marking.kind,
      isCopy: marking.isCopy,
      isGroup: false,
      ...markingData(marking)
    }, printMode);
  }

  function tapeCellHtml(marking, isGrouped, printMode, isPrintView = false) {
    if (isPrintView) return printStickerHtml(marking, printMode);
    const module = marking.kind === 'module' ? moduleById(marking.refId) : null;
    const title = tapeTitleFor(marking);
    const tag = String(module?.tag || '').trim() || marking.mainSnapshot || '—';
    const description = tapeDescriptionFor(marking);
    const color = HEX_COLOR_RE.test(String(marking.color || ''))
      ? marking.color.toLowerCase()
      : DEFAULT_TAPE_COLOR;
    const classes = ['tape-cell'];
    if (isGrouped) classes.push('is-grouped');
    // Многополюсный модуль: текст центрируется на всей ширине наклейки.
    if (module && Math.max(1, Math.round(Number(module.width) || 1)) > 1) classes.push('is-wide');
    if (!printMode && selectedTapeMarkingId === marking.id) classes.push('is-selected');
    const attrs = printMode
      ? ''
      : ` type="button" data-marking-id="${escapeHtml(marking.id)}" ` +
        `title="${escapeHtml(`${tag} · ${description || module?.name || 'Модуль'} — клик для редактирования`)}" ` +
        `aria-label="${escapeHtml(`Ячейка ${tag}, ${description || module?.name || 'модуль'}`)}"`;
    const tagName = printMode ? 'div' : 'button';
    return `<${tagName} class="${classes.join(' ')}" style="--cell-w:${tapeWidthFor(marking)}mm;--tape-color:${color}"${attrs}>
      <span class="tape-zone tape-zone-top">
        <span class="tape-brand">${escapeHtml(title.brand)}</span>
        <span class="tape-model">${escapeHtml(title.model)}</span>
        <span class="tape-rating">${escapeHtml(title.meta)}</span>
      </span>
      <span class="tape-zone tape-zone-icon">
        ${tapeIconHtml('breaker', 'tape-device-icon')}
      </span>
      <span class="tape-zone tape-zone-tag">
        <span class="tape-tag">${escapeHtml(tag)}</span>
        <span class="tape-color" aria-hidden="true"></span>
      </span>
      <span class="tape-zone tape-zone-desc">
        ${tapeIconHtml(marking.icon, 'tape-desc-icon')}
        <span class="tape-desc-text">${escapeHtml(description)}</span>
      </span>
    </${tagName}>`;
  }

  // Заглушка на месте пропущенных слотов рейки. Ширина кратна 18 мм,
  // поэтому наклейки после неё остаются на своих физических позициях.
  function tapeSpacerHtml(item) {
    const title = `${item.slots} ${plural(item.slots, ['пустой слот', 'пустых слота', 'пустых слотов'])}`;
    return `<div class="tape-spacer" style="--cell-w:${item.width}mm" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">` +
      `<span class="tape-spacer-text">${item.slots} ${plural(item.slots, ['слот', 'слота', 'слотов'])}</span></div>`;
  }

  // Один ряд рейки. Используется и лентой, и печатным листом — разница
  // только в том, в какой контейнер попадает результат.
  function markingRowHtml(row, printMode, isPrintView = false) {
    const cells = row.items.map((item) =>
      item.type === 'spacer'
        ? tapeSpacerHtml(item)
        : tapeCellHtml(item.marking, item.members.length > 1, printMode, isPrintView)
    ).join('');
    // На печатном листе общая подпись не накладывается на компактную наклейку.
    const groupLabels = isPrintView ? '' : row.items
      .filter((item) => item.type === 'module' && item.members.length > 1)
      .map((item) => `<div class="tape-group-label" style="left:${item.left}mm;width:${item.width}mm">` +
        `${escapeHtml(item.groupText || 'Общая подпись')}</div>`)
      .join('');
    const trackContent = row.items.length
      ? cells + groupLabels
      : `<div class="tape-empty">На этой рейке нет модулей</div>`;
    const rail = `<div class="marking-rail">` +
      `<div class="tape-rail-track" style="width:${row.width || row.total || 90}mm">${trackContent}</div>` +
      `</div>`;
    // Слишком длинный фрагмент рейки, который не разбить по модулям,
    // уменьшается до ширины листа. Обычные ряды остаются 1:1.
    const scale = row.scale && row.scale < 1 ? row.scale : 1;
    const content = scale < 1
      ? `<div class="tape-rail-scale" style="--rail-scale:${scale.toFixed(4)};` +
        `--scaled-w:${(row.width * scale).toFixed(2)}mm;` +
        `--scaled-h:${(TAPE_CELL_HEIGHT_MM * scale).toFixed(2)}mm">${rail}</div>`
      : rail;
    return `<section class="tape-rail-row${row.continuation ? ' is-continuation' : ''}" ` +
      `data-rail-index="${row.railIndex}">
        <div class="tape-rail-heading">
          <span class="tape-rail-name">${escapeHtml(row.label)}</span>
          <span class="tape-rail-meta">${row.moduleCount} ` +
            `${plural(row.moduleCount, ['модуль', 'модуля', 'модулей'])} · ${row.rail.capacity} P</span>
          ${row.continuation ? '<span class="tape-continuation">Продолжение рейки</span>' : ''}
        </div>
        ${content}
      </section>`;
  }

  // Длинную заглушку можно разрезать на куски по ширине листа — так она
  // не растягивает ряд и не ломает масштаб соседних наклеек.
  function splitTapeSpacer(item, maxWidth) {
    if (item.width <= maxWidth) return [item];
    const parts = [];
    let left = item.left;
    let restWidth = item.width;
    let restSlots = item.slots;
    while (restWidth > maxWidth + 0.01) {
      const slots = Math.max(1, Math.floor(maxWidth / MM_PER_MODULE));
      const width = slots * MM_PER_MODULE;
      parts.push({ ...item, left, width, slots });
      left += width;
      restWidth -= width;
      restSlots -= slots;
    }
    if (restWidth > 0) {
      parts.push({
        ...item,
        left,
        width: restWidth,
        slots: Math.max(1, restSlots || Math.round(restWidth / MM_PER_MODULE))
      });
    }
    return parts;
  }

  // Разбивает рейку на части, которые влезают в доступную ширину листа.
  // Каждая часть сохраняет свои пустые слоты и ширину многополюсных модулей.
  function splitTapeRow(row, maxWidth) {
    if (!maxWidth || row.total <= maxWidth) {
      return [{ ...row, type: 'rail', width: row.total, scale: 1 }];
    }
    const flat = [];
    row.items.forEach((item) => {
      if (item.type === 'spacer') flat.push(...splitTapeSpacer(item, maxWidth));
      else flat.push(item);
    });
    const chunks = [];
    let items = [];
    let width = 0;
    flat.forEach((item) => {
      if (items.length && width + item.width > maxWidth) {
        chunks.push({ items, width });
        items = [];
        width = 0;
      }
      items.push(item);
      width += item.width;
    });
    if (items.length) chunks.push({ items, width });
    if (!chunks.length) return [{ ...row, type: 'rail', width: row.total, scale: 1 }];
    return chunks.map((chunk, index) => {
      const startLeft = chunk.items[0]?.left || 0;
      const scale = chunk.width > maxWidth ? Math.max(0.1, maxWidth / chunk.width) : 1;
      return {
        ...row,
        type: 'rail',
        items: chunk.items.map((item) => ({ ...item, left: item.left - startLeft })),
        width: chunk.width,
        total: chunk.width,
        scale,
        continuation: index > 0,
        moduleCount: chunk.items.filter((item) => item.type === 'module').length
      };
    });
  }

  // Единый генератор разметки наклеек. Ряды реек, заглушки пустых слотов
  // и ширина многополюсных модулей считаются здесь один раз; «Лента» и
  // «Лист 1:1» отличаются только CSS-контейнером, в который кладут html.
  function generateMarkingHTML(options = {}) {
    const printMode = options.printMode === true;
    // isPrintView — признак вкладки «Лист 1:1». Лента сохраняет объёмные
    // цветные ячейки .tape-cell, лист использует компактные .print-sticker.
    const isPrintView = options.isPrintView === true;
    const maxWidth = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : null;
    const layout = tapeLayout();
    const parts = [];
    layout.rows.forEach((row) => {
      splitTapeRow(row, maxWidth).forEach((part) => parts.push(part));
    });
    const wires = wireTagsHtml(printMode, maxWidth, isPrintView);
    if (wires.html) {
      parts.push({ type: 'wires', html: wires.html, width: wires.width, height: wires.height });
    }
    const rendered = parts.map((part) => ({
      ...part,
      html: part.type === 'wires' ? part.html : markingRowHtml(part, printMode, isPrintView)
    }));
    return {
      html: rendered.map((part) => part.html).join(''),
      layout,
      parts: rendered,
      width: Math.max(layout.total, 36)
    };
  }

  function buildTapeMarkup(printMode) {
    const generated = generateMarkingHTML({ printMode });
    return { html: generated.html, width: generated.width, layout: generated.layout };
  }

  function renderTape() {
    if (!dom.markingTape || !project) return;
    if (selectedTapeMarkingId) {
      const exists = markings().some((item) =>
        item.id === selectedTapeMarkingId && item.kind === 'module' && !item.hidden);
      if (!exists) selectedTapeMarkingId = null;
    }
    const tape = buildTapeMarkup(false);
    dom.markingTape.innerHTML = tape.html;
    dom.markingTape.style.width = `${tape.width}mm`;
    if (dom.markingTapeViewport) {
      dom.markingTapeViewport.classList.toggle('is-picking', Boolean(tapePendingIcon));
    }
    updateTapeProps();
  }

  function tapeToolButtonHtml(key, icon) {
    const glyph = icon.svg
      ? `<span class="marking-tool-glyph"><svg viewBox="0 0 24 24">${icon.svg}</svg></span>`
      : `<span class="marking-tool-glyph" aria-hidden="true">${escapeHtml(icon.emoji || '·')}</span>`;
    return `<button class="marking-tool" type="button" data-tape-icon="${escapeHtml(key)}"
      title="${escapeHtml(icon.label)}" aria-label="${escapeHtml(icon.label)}"
      aria-pressed="false">${glyph}<span class="marking-tool-label">${escapeHtml(icon.label)}</span></button>`;
  }

  function renderTapeTools() {
    if (!dom.markingToolsList) return;
    dom.markingToolsList.innerHTML = Object.entries(MARKING_ICONS)
      .filter(([key]) => key !== 'none')
      .map(([key, icon]) => tapeToolButtonHtml(key, icon)).join('');
    if (dom.tapeIconPicker) {
      dom.tapeIconPicker.innerHTML = Object.entries(MARKING_ICONS).map(([key, icon]) => `
        <button class="marking-icon-option" type="button" data-icon="${escapeHtml(key)}"
                title="${escapeHtml(icon.label)}" aria-label="${escapeHtml(icon.label)}"
                aria-pressed="false">${icon.svg
                  ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.svg}</svg>`
                  : `<span aria-hidden="true">${escapeHtml(icon.emoji || '—')}</span>`}</button>`).join('');
    }
    if (dom.tapeColorSwatches) {
      dom.tapeColorSwatches.innerHTML = MARKING_TAPE_COLORS.map((color) => `
        <button class="tape-color-swatch" type="button" data-color="${escapeHtml(color.value)}"
                style="--swatch:${escapeHtml(color.value)}" title="${escapeHtml(color.label)}"
                aria-label="${escapeHtml(color.label)}" aria-pressed="false"></button>`).join('');
    }
    updateTapeToolsState();
  }

  function updateTapeToolsState() {
    if (dom.markingToolsList) {
      dom.markingToolsList.querySelectorAll('[data-tape-icon]').forEach((button) => {
        const active = button.dataset.tapeIcon === tapePendingIcon;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    if (dom.markingToolHint) {
      dom.markingToolHint.textContent = tapePendingIcon
        ? `Выбран: ${MARKING_ICONS[tapePendingIcon]?.label || ''} · кликните по ячейке`
        : 'Выберите значок';
    }
    if (dom.markingTapeViewport) {
      dom.markingTapeViewport.classList.toggle('is-picking', Boolean(tapePendingIcon));
    }
  }

  function updateTapeProps() {
    const marking = markings().find((item) => item.id === selectedTapeMarkingId);
    const hasSelection = Boolean(marking && marking.kind === 'module');
    if (dom.tapePropsEmpty) dom.tapePropsEmpty.hidden = hasSelection;
    if (dom.tapePropsBody) dom.tapePropsBody.hidden = !hasSelection;
    if (!hasSelection) {
      if (dom.tapePropsTarget) dom.tapePropsTarget.textContent = 'Элемент не выбран';
      return;
    }
    const module = moduleById(marking.refId);
    const libraryItem = module ? LIBRARY_BY_ID.get(module.libraryId) : null;
    const data = markingData(marking);
    if (dom.tapePropsTarget) {
      dom.tapePropsTarget.textContent =
        `${module?.tag || '—'} · ${libraryItem?.typeLabel || module?.type || 'модуль'}`;
    }
    if (dom.tapeTagInput && document.activeElement !== dom.tapeTagInput) {
      dom.tapeTagInput.value = module?.tag || '';
    }
    if (dom.tapeDescInput && document.activeElement !== dom.tapeDescInput) {
      dom.tapeDescInput.value = String(module?.description || '');
    }
    if (dom.tapeIconPicker) {
      dom.tapeIconPicker.querySelectorAll('[data-icon]').forEach((button) => {
        const active = button.dataset.icon === marking.icon;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    if (dom.tapeColorSwatches) {
      dom.tapeColorSwatches.querySelectorAll('[data-color]').forEach((button) => {
        const active = button.dataset.color === marking.color;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    if (dom.tapeColorCustom) dom.tapeColorCustom.value = marking.color || DEFAULT_TAPE_COLOR;
    if (dom.tapeMergeCheck) dom.tapeMergeCheck.checked = Boolean(marking.groupId);
    if (dom.tapePropsMeta) {
      dom.tapePropsMeta.textContent = [
        `Реальный размер: ${data.widthMm} × ${data.heightMm} мм`,
        module?.name || '',
        libraryItem?.brand ? `Бренд: ${libraryItem.brand}` : ''
      ].filter(Boolean).join(' · ');
    }
  }

  function selectTapeMarking(markingId) {
    selectedTapeMarkingId = markingId;
    if (tapePendingIcon) {
      const marking = markings().find((item) => item.id === markingId);
      if (marking) {
        marking.icon = tapePendingIcon;
        tapePendingIcon = null;
        updateTapeToolsState();
        commitMarkingChange('Значок назначен ячейке');
        return;
      }
    }
    renderTape();
  }

  function applyTapeIcon(iconKey) {
    if (!MARKING_ICONS[iconKey] || iconKey === 'none') return;
    tapePendingIcon = iconKey;
    updateTapeToolsState();
    if (!selectedTapeMarkingId) {
      showToast('Выберите ячейку на ленте — значок будет применён', 'success', 2000);
      return;
    }
    const marking = markings().find((item) => item.id === selectedTapeMarkingId);
    if (!marking) return;
    marking.icon = iconKey;
    tapePendingIcon = null;
    commitMarkingChange('Иконка обновлена');
  }

  function applyTapeColor(value) {
    const color = String(value || '').toLowerCase();
    if (!HEX_COLOR_RE.test(color)) return;
    const marking = markings().find((item) => item.id === selectedTapeMarkingId);
    if (!marking) return;
    marking.color = color;
    commitMarkingChange('Цвет полосы обновлён');
  }

  function setTapeMerge(enabled) {
    const marking = markings().find((item) => item.id === selectedTapeMarkingId);
    if (!marking || marking.kind !== 'module') return;
    if (!enabled) {
      const groupId = marking.groupId;
      if (groupId) {
        markings().forEach((item) => {
          if (item.groupId === groupId) item.groupId = '';
        });
      }
      commitMarkingChange('Объединение снято');
      return;
    }
    // Соседей ищем только внутри рейки этой наклейки: объединять ряды нельзя.
    const row = tapeLayout().rows.find((item) =>
      item.items.some((cell) => cell.type === 'module' &&
        cell.members.some((member) => member.id === marking.id)));
    const list = row ? row.items.filter((cell) => cell.type === 'module').map((cell) => cell.marking) : [];
    const index = list.findIndex((item) => item.id === marking.id);
    if (index < 0) return;
    const members = [marking];
    const left = list[index - 1];
    const right = list[index + 1];
    if (left && !left.groupId && !left.isCopy) members.unshift(left);
    if (right && !right.groupId && !right.isCopy) members.push(right);
    if (members.length < 2) {
      showToast('Нет свободных соседних ячеек для объединения', 'error', 2500);
      if (dom.tapeMergeCheck) dom.tapeMergeCheck.checked = false;
      return;
    }
    const groupId = makeId('grp');
    members.forEach((item) => { item.groupId = groupId; });
    commitMarkingChange(`Объединено ячеек: ${members.length}`);
  }

  function resetTapeCell() {
    const marking = markings().find((item) => item.id === selectedTapeMarkingId);
    if (!marking) return;
    const module = moduleById(marking.refId);
    if (module) module.description = '';
    marking.icon = 'none';
    marking.color = DEFAULT_TAPE_COLOR;
    if (marking.groupId) {
      const groupId = marking.groupId;
      markings().forEach((item) => {
        if (item.groupId === groupId) item.groupId = '';
      });
    }
    commitMarkingChange('Оформление ячейки сброшено', true);
  }

  function setMarkingMode(mode) {
    markingMode = mode === 'sheet' ? 'sheet' : 'tape';
    if (dom.markingView) dom.markingView.dataset.mode = markingMode;
    document.querySelectorAll('[data-marking-mode]').forEach((button) => {
      const active = button.dataset.markingMode === markingMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (dom.markingSheetFold) {
      if (markingMode === 'sheet') dom.markingSheetFold.open = true;
      else dom.markingSheetFold.open = false;
    }
    if (dom.markingPrint) {
      dom.markingPrint.title = markingMode === 'tape'
        ? 'Печать ленты: только наклейки на белом фоне, масштаб 1:1'
        : 'Печать листа наклеек: A4 альбомный, поля 0, масштаб 1:1';
    }
    // Размер и поля страницы на листе 1:1 не настраиваются — они жёстко
    // заданы для сохранения масштаба. Остальные переключатели доступны.
    const sheetMode = markingMode === 'sheet';
    [dom.markingSize, dom.markingOrientation, dom.markingMarginTop,
      dom.markingMarginRight, dom.markingMarginBottom, dom.markingMarginLeft]
      .forEach((input) => { if (input) input.disabled = sheetMode; });
    syncMarkingSettingsUI();
    if (markingMode === 'tape') renderTape();
  }

  function renderTapePrintSheet() {
    if (!dom.markingTapePrint) return;
    const tape = buildTapeMarkup(true);
    // Легенда и контрольный размер идут сразу под лентой наклеек.
    const settings = markingSettings();
    const legendEntries = settings.printLegend ? markingLegendEntries() : [];
    dom.markingTapePrint.innerHTML =
      `<div class="marking-tape" style="width:${tape.width}mm">${tape.html}</div>` +
      markingLegendHtml(legendEntries) +
      markingScaleMarkerHtml();
  }

  function applyTapePageStyle() {
    if (!dom.markingPageStyle) return;
    const settings = markingSettings();
    dom.markingPageStyle.textContent =
      `@page { size: ${settings.sheet} ${settings.orientation}; ` +
      `margin: ${settings.marginTop}mm ${settings.marginRight}mm ` +
      `${settings.marginBottom}mm ${settings.marginLeft}mm; }`;
  }

  function printTape() {
    printContext = 'marking';
    document.body.classList.add('print-tape');
    document.body.classList.remove('print-marking');
    renderTapePrintSheet();
    applyTapePageStyle();
    window.print();
  }

  function printActiveMarking() {
    if (markingMode === 'sheet') printMarking();
    else printTape();
  }

  // Скачивание ленты как SVG: единицы миллиметров, без растеризации —
  // размеры наклеек остаются 1:1 при любом последующем выводе.
  function downloadTape() {
    if (!project) return;
    const tape = buildTapeMarkup(false);
    const padding = 2;
    const width = tape.width + padding * 2;
    const rowHeight = TAPE_CELL_HEIGHT_MM + TAPE_RAIL_HEADING_MM;
    const rows = tape.layout.rows;
    const height = padding * 2 + rows.length * rowHeight +
      Math.max(0, rows.length - 1) * TAPE_RAIL_GAP_MM;
    let body = `<rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>`;
    rows.forEach((row, rowIndex) => {
      const top = padding + rowIndex * (rowHeight + TAPE_RAIL_GAP_MM);
      const y = top + TAPE_RAIL_HEADING_MM;
      body += `<text x="${padding}" y="${top + 5}" font-family="Arial" font-size="3" font-weight="700" fill="#0f172a">` +
        `${escapeHtml(row.label)}</text>`;
      row.items.forEach((item) => {
        if (item.type === 'spacer') return; // пустые слоты остаются чистым полем
        const offsetX = padding + item.left;
        item.members.forEach((marking, memberIndex) => {
          const module = moduleById(marking.refId);
          const w = tapeWidthFor(marking);
          const x = offsetX + item.members.slice(0, memberIndex)
            .reduce((sum, member) => sum + tapeWidthFor(member), 0);
        const title = tapeTitleFor(marking);
        const tag = String(moduleById(marking.refId)?.tag || '').trim() || '—';
        const description = tapeDescriptionFor(marking);
        const color = HEX_COLOR_RE.test(String(marking.color || ''))
          ? marking.color.toLowerCase() : DEFAULT_TAPE_COLOR;
        const breaker = MARKING_ICONS.breaker.svg;
        const dest = MARKING_ICONS[marking.icon]?.svg || '';
        const tagW = Math.max(5, Math.min(w - 2.4, 3 + tag.length * 1.7));
        const tagX = x + (w - tagW) / 2;
        const descChars = Math.max(4, Math.floor((w - 2) / 1.25));
        const descText = description.length > descChars
          ? `${description.slice(0, descChars - 1)}…` : description;
        const wide = module ? Math.max(1, Math.round(Number(module.width) || 1)) > 1 : false;
        const headX = wide ? x + w / 2 : x + 0.8;
        const headAnchor = wide ? 'middle' : 'start';
        body += `<g>
          <rect x="${x}" y="${y}" width="${w}" height="${TAPE_CELL_HEIGHT_MM}" fill="#f8fafc" stroke="#64748b" stroke-width="0.25"/>
          <path d="M${x} ${y + 13} H${x + w} M${x} ${y + 22} H${x + w} M${x} ${y + 32} H${x + w}"
                stroke="#cbd5e1" stroke-width="0.2" fill="none"/>
          <text x="${headX}" y="${y + 3.2}" text-anchor="${headAnchor}" font-family="Arial" font-size="1.9" font-weight="700" fill="#334155">${escapeHtml(title.brand)}</text>
          <text x="${headX}" y="${y + 6.2}" text-anchor="${headAnchor}" font-family="Arial" font-size="2.4" font-weight="700" fill="#0f172a">${escapeHtml(title.model)}</text>
          <text x="${headX}" y="${y + 9.2}" text-anchor="${headAnchor}" font-family="Arial" font-size="1.8" fill="#64748b">${escapeHtml(title.meta)}</text>
          <g transform="translate(${x + w / 2 - 3}, ${y + 14}) scale(0.25)" stroke="#1e293b" stroke-width="1.6"
             fill="none" stroke-linecap="round" stroke-linejoin="round">${breaker}</g>
          <rect x="${tagX}" y="${y + 23.2}" width="${tagW}" height="6.4" rx="0.6"
                fill="#fde047" stroke="#a16207" stroke-width="0.25"/>
          <text x="${x + w / 2 - 1.5}" y="${y + 27.6}" text-anchor="middle" font-family="Arial"
                font-size="3" font-weight="700" fill="#422006">${escapeHtml(tag)}</text>
          <rect x="${x + w - 2.4}" y="${y + 23.2}" width="1.8" height="6.4" rx="0.4"
                fill="${escapeHtml(color)}" stroke="#0f172a" stroke-opacity="0.35" stroke-width="0.2"/>
          ${dest ? `<g transform="translate(${x + w / 2 - 1.2}, ${y + 33.2}) scale(0.1)" stroke="#1e293b"
             stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">${dest}</g>` : ''}
          <text x="${x + w / 2}" y="${y + 40.5}" text-anchor="middle" font-family="Arial"
                font-size="2.1" font-weight="700" fill="#1e293b">${escapeHtml(descText)}</text>
        </g>`;
      });
      if (item.members.length > 1) {
        body += `<rect x="${offsetX}" y="${y + 32.8}" width="${item.width}" height="11.2" rx="0.8"
          fill="#fff" stroke="#000" stroke-width="0.25" stroke-dasharray="1 0.6"/>
          <text x="${offsetX + item.width / 2}" y="${y + 39.6}" text-anchor="middle"
          font-family="Arial" font-size="2.7" font-weight="700" fill="#000">${escapeHtml(item.groupText || 'Общая подпись')}</text>`;
      }
      });
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" ` +
      `viewBox="0 0 ${width} ${height}">${body}</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(blob, `marking-tape-${safeFileName(project.name)}-${fileDate()}.svg`);
    showToast('Лента скачана в SVG (масштаб 1:1)', 'success', 2600);
  }

  function printMarking() {
    printContext = 'marking';
    // Класс выставляем сразу: не все браузеры последовательно генерируют
    // beforeprint для программного вызова window.print().
    document.body.classList.add('print-marking');
    document.body.classList.remove('print-tape');
    renderMarking();
    updateMarkingPageStyle('marking');
    window.print();
  }

  /* -------------------- Инлайн-редактирование цены --------------------- */

  // Приводим введённое значение к числу: пустая строка, буквы, минус
  // и слишком большие числа считаются некорректными (возвращаем null).
  function parseCustomPrice(value) {
    const text = String(value ?? '')
      .trim()
      .replace(/\s+/g, '')
      .replace(',', '.');
    if (!text) return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CUSTOM_PRICE) return null;
    return roundMoney(parsed);
  }

  // Единая точка сохранения: цена пишется в нужный объект проекта (модули
  // или кабели), уходит в localStorage, после чего пересчитываются
  // спецификация и вся таблица сметы.
  function applyCustomPrice(key, price, kind) {
    if (kind === 'wire') {
      if (!project.customCablePrices || typeof project.customCablePrices !== 'object' ||
          Array.isArray(project.customCablePrices)) {
        project.customCablePrices = {};
      }
      project.customCablePrices[key] = price;
    } else {
      if (!project.customPrices || typeof project.customPrices !== 'object' ||
          Array.isArray(project.customPrices)) {
        project.customPrices = {};
      }
      project.customPrices[key] = price;
    }
    persistProject();
    renderAll();       // спецификация, метрики, состояние кнопок
    renderEstimate();  // сумма строки и общий итог с новыми ценами
    showToast(kind === 'wire'
      ? 'Цена кабеля сохранена, смета пересчитана'
      : 'Цена сохранена, смета пересчитана', 'success', 2400);
  }

  function startPriceEdit(cell) {
    if (!cell || cell.classList.contains('is-editing')) return;
    const key = cell.dataset.priceKey;
    const kind = cell.dataset.priceKind === 'wire' ? 'wire' : 'module';
    const oldPrice = Number(cell.dataset.priceValue);
    if (!key || !Number.isFinite(oldPrice)) return;

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(MAX_CUSTOM_PRICE);
    input.step = '0.01';
    input.className = 'est-price-input';
    input.value = String(oldPrice);
    input.title = 'Enter — сохранить · Esc — отмена · потеря фокуса — сохранить';
    input.setAttribute('aria-label', 'Новая цена, руб');

    cell.replaceChildren(input);
    cell.classList.add('is-editing');
    input.focus();
    input.select();

    // Guard защищает от повторного сохранения: после перерисовки таблицы
    // у удалённого поля срабатывает blur, но он уже ничего не должен менять.
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;

      if (!commit) {
        renderEstimate();
        return;
      }
      const price = parseCustomPrice(input.value);
      if (price === null) {
        showToast('Некорректная цена — сохранено прежнее значение', 'error', 3000);
        renderEstimate();
        return;
      }
      const prices = kind === 'wire'
        ? project.customCablePrices
        : project.customPrices;
      const alreadyCustom = Object.prototype.hasOwnProperty.call(prices || {}, key);
      if (price === roundMoney(oldPrice) && alreadyCustom) {
        renderEstimate();
        return;
      }
      applyCustomPrice(key, price, kind);
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      } else if (event.key === '-' || event.key === '+' ||
                 event.key === 'e' || event.key === 'E') {
        // type="number" всё равно пропускает эти символы — запрещаем ввод.
        event.preventDefault();
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function renderEstimate() {
    const estimate = buildEstimate();
    const emptyMessage = 'Проект пуст. Добавьте модули для расчета сметы.';
    const projectTitle = project?.name || 'Новый щит';
    const today = new Date().toLocaleDateString('ru-RU');

    if (dom.estimateSubtitle) {
      dom.estimateSubtitle.textContent = `${projectTitle} · ${today} · цену можно изменить кликом по ячейке`;
    }

    if (dom.estimateContent) {
      dom.estimateContent.innerHTML = estimate.hasModules
        ? estimateTableHtml(estimate.rows, estimate.total)
        : `<p class="estimate-empty">${escapeHtml(emptyMessage)}</p>`;
    }

    // Печатный лист строится из тех же данных, что и окно сметы.
    if (dom.estimatePrintSheet) {
      dom.estimatePrintSheet.innerHTML = estimate.hasModules
        ? `<h1>Смета проекта</h1>
           <p class="print-meta">${escapeHtml(projectTitle)} · ${escapeHtml(today)}</p>
           ${estimateTableHtml(estimate.rows, estimate.total)}`
        : `<h1>Смета проекта</h1><p>${escapeHtml(emptyMessage)}</p>`;
    }

    if (dom.estimateDownloadCsv) dom.estimateDownloadCsv.disabled = !estimate.hasModules;
    if (dom.estimatePrint) dom.estimatePrint.disabled = !estimate.hasModules;
    return estimate;
  }

  function openEstimate() {
    renderEstimate();
    if (dom.estimateDialog && typeof dom.estimateDialog.showModal === 'function') {
      dom.estimateDialog.showModal();
    }
  }

  function exportEstimateCsv() {
    // renderEstimate() заново строит смету через buildEstimate() →
    // modulePrice(), поэтому в CSV уходят в том числе вручную введённые цены.
    const estimate = renderEstimate();
    if (!estimate.hasModules) return;

    const rows = [
      ['№', 'Наименование', 'Бренд', 'Артикул', 'Кол-во', 'Ед. изм.', 'Цена (руб)', 'Сумма (руб)'],
      ...estimate.rows.map((row, index) => [
        String(index + 1),
        row.name,
        row.brand,
        row.sku,
        csvNumber(formatQty(row)),
        row.unit,
        csvNumber(row.price),
        csvNumber(row.total)
      ]),
      ['', 'ИТОГО:', '', '', '', '', '', csvNumber(estimate.total)]
    ];

    // BOM UTF-8 + ';' — Excel с русской локалью открывает файл без кракозябр.
    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `smeta-${safeFileName(project?.name)}-${fileDate()}.csv`);
    showToast('Смета экспортирована в CSV', 'success', 2600);
  }

  function printEstimate() {
    printContext = 'estimate';
    renderEstimate();
    window.print();
  }

  /* ------------------- Весь проект в один документ --------------------
     Собирает титульный блок, клон схемы, смету, кабельный журнал и печатный
     лист маркировки в один контейнер. Разделы идут с новой страницы
     (break-before: page), схема — на первой вместе с титулом.
     =================================================================== */

  function buildFullPrintView() {
    if (!project || !dom.fullPrintView) return false;

    // Все источники пересобираются из текущего проекта: в документ должны
    // попасть актуальные цены, длины проводов и правки наклеек.
    renderEstimate();
    renderJournal();
    renderMarking();

    const projectTitle = project.name || 'Новый щит';
    const today = new Date().toLocaleDateString('ru-RU');
    const estimate = buildEstimate();
    const journal = buildJournal();
    const scheme = cloneCanvasForPrint();
    const logoSvg = document.querySelector('.brand-mark svg');
    const moduleCount = allModules().length;
    const meta = [
      `Рейки: ${project.rails.length}`,
      `Модули: ${moduleCount}`,
      `Соединения: ${project.connections.length}`,
      `Смета: ${formatMoney(estimate.total)} руб.`
    ].join(' · ');
    const markingHtml = dom.markingPrintSheet?.innerHTML || '';

    dom.fullPrintView.innerHTML = `
      <header class="fp-titleblock">
        <div class="fp-logo">${logoSvg ? logoSvg.outerHTML : ''}</div>
        <div class="fp-title-copy">
          <p class="fp-kicker">Щит.Студия · проектная документация</p>
          <h1>${escapeHtml(projectTitle)}</h1>
          <p class="fp-title-meta">Дата: ${escapeHtml(today)} · ${escapeHtml(meta)}</p>
          <p class="fp-title-meta">Разделы: схема щита · смета · кабельный журнал · маркировка (наклейки 1:1)</p>
        </div>
      </header>

      <section class="fp-section fp-scheme" aria-label="Схема щита">
        <h2>1. Схема щита</h2>
        ${scheme
          ? '<p class="fp-subtitle">Схема сборки с модулями и соединениями</p>'
          : '<p class="fp-empty">Не удалось подготовить изображение схемы.</p>'}
      </section>

      <section class="fp-section fp-estimate" aria-label="Смета проекта">
        <h2>2. Смета проекта</h2>
        <p class="fp-subtitle">${escapeHtml(projectTitle)} · ${escapeHtml(today)}</p>
        ${estimate.hasModules
          ? estimateTableHtml(estimate.rows, estimate.total)
          : '<p class="fp-empty">Проект пуст. Добавьте модули для расчёта сметы.</p>'}
      </section>

      <section class="fp-section fp-journal" aria-label="Кабельный журнал">
        <h2>3. Кабельный журнал</h2>
        <p class="fp-subtitle">${escapeHtml(projectTitle)} · ${escapeHtml(today)} · ${journal.rows.length} ${plural(journal.rows.length, ['провод', 'провода', 'проводов'])} · ${formatCableLength(journal.totalLength)}</p>
        ${journalTableHtml(journal.rows, journal.totalLength)}
      </section>

      <section class="fp-section fp-marking" aria-label="Маркировка">
        <div class="marking-print-sheet">${markingHtml}</div>
      </section>`;

    if (scheme) dom.fullPrintView.querySelector('.fp-scheme').appendChild(scheme);
    // Таблицы приходят из общих функций сметы/журнала: добавляем общий класс,
    // под который написаны печатные стили полного документа.
    dom.fullPrintView.querySelectorAll('.fp-estimate table, .fp-journal table')
      .forEach((table) => table.classList.add('fp-table'));
    dom.fullPrintView.setAttribute('aria-hidden', 'false');
    return true;
  }

  function printFullProject() {
    if (!project) {
      showToast('Сначала создайте проект.', 'error', 2600);
      return;
    }
    if (!buildFullPrintView()) {
      showToast('Не удалось собрать печатный документ.', 'error', 3200);
      return;
    }

    printContext = 'full';
    // print-marking включается для переиспользования готовых стилей
    // печатного листа наклеек 1:1; print-full скрывает весь остальной UI.
    document.body.classList.add('print-full', 'print-marking');
    document.body.classList.remove('print-estimate', 'print-tape');
    updateMarkingPageStyle('marking');
    window.print();
  }

  function clearFullPrintView() {
    document.body.classList.remove('print-full');
    if (dom.fullPrintView) {
      dom.fullPrintView.replaceChildren();
      dom.fullPrintView.setAttribute('aria-hidden', 'true');
    }
  }

  /* ------------------------------ PNG --------------------------------- */

  // Свойства, которые реально влияют на внешний вид SVG. Переносим их
  // вычисленные значения напрямую в клон: отдельный SVG-файл не видит
  // CSS-переменные и правила со страницы, поэтому без этого тёмная тема
  // и все цвета модулей/проводов потерялись бы.
  const EXPORT_STYLE_PROPERTIES = Object.freeze([
    'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
    'opacity', 'visibility', 'display', 'filter', 'color',
    'font-family', 'font-size', 'font-weight', 'font-style',
    'letter-spacing', 'text-anchor', 'dominant-baseline',
    'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
    'paint-order'
  ]);

  // getComputedStyle возвращает url() с полным путём к странице.
  // В автономном SVG нужны только локальные ссылки на defs (#gradient и т.п.).
  function localSvgUrl(value) {
    return String(value).replace(/url\([^)]*?#([^)'"]+)[^)]*\)/g, 'url(#$1)');
  }

  function inlineComputedStyles(source, clone) {
    const sourceElements = [source, ...source.querySelectorAll('*')];
    const cloneElements = [clone, ...clone.querySelectorAll('*')];

    sourceElements.forEach((element, index) => {
      const target = cloneElements[index];
      if (!target) return;
      const computed = window.getComputedStyle(element);
      const declarations = [];

      for (const property of EXPORT_STYLE_PROPERTIES) {
        const value = computed.getPropertyValue(property).trim();
        if (value) declarations.push(`${property}:${localSvgUrl(value)}`);
      }
      if (declarations.length === 0) return;

      const existing = target.getAttribute('style') || '';
      target.setAttribute('style', existing
        ? `${existing};${declarations.join(';')}`
        : declarations.join(';'));
    });
  }

  // Реальный габарит схемы в координатах viewBox. Пластина холста задаёт
  // минимальную область, но провода, подписи и бейджи могут выходить за неё
  // (например, нижние ряды проводов под последней рейкой). Объединяем bbox
  // всех видимых элементов с пластиной — так PNG всегда содержит всю схему,
  // а не только текущую область просмотра.
  function exportBounds(width, height) {
    const area = { left: 0, top: 0, right: width, bottom: height };
    const layers = [
      dom.railTrack,
      dom.wireLayer,
      dom.moduleLayer,
      dom.powerSourceLayer,
      dom.labelLayer,
      dom.notesLayer
    ];
    // Служебные элементы интерфейса в картинку не попадают и в габарите не участвуют.
    const uiSelector = [
      '[data-delete-module]',
      '[data-delete-wire]',
      '[data-delete-rail]',
      '[data-rail-capacity]',
      '.rail-cap-control',
      '.wire-halo',
      '.module-focus-ring',
      '.module-pending-badge',
      '.rail-overflow-outline',
      '.rail-slot-highlight',
      '.note-delete'
    ].join(', ');

    for (const layer of layers) {
      if (!layer) continue;
      for (const element of layer.children) {
        if (element.matches?.(uiSelector)) continue;
        let box;
        try {
          box = element.getBBox();
        } catch {
          continue;
        }
        if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) continue;
        if (box.width <= 0 || box.height <= 0) continue;
        area.left = Math.min(area.left, box.x);
        area.top = Math.min(area.top, box.y);
        area.right = Math.max(area.right, box.x + box.width);
        area.bottom = Math.max(area.bottom, box.y + box.height);
      }
    }

    const x = Math.floor(area.left - EXPORT_BBOX_MARGIN);
    const y = Math.floor(area.top - EXPORT_BBOX_MARGIN);
    const right = Math.ceil(area.right + EXPORT_BBOX_MARGIN);
    const bottom = Math.ceil(area.bottom + EXPORT_BBOX_MARGIN);
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  function stabilizeCanvasForExport() {
    if (!dragState && !gesture && !activePort && !pendingWire &&
        !selectedConnectionId && selectedModuleIds.size === 0 && !selectedNoteId) return;

    resetInteractionState();
    clearConnectionDraft();
    clearSelection();
    selectedConnectionId = null;
    selectedNoteId = null;
    renderCanvas();
    updateConnectionUI();
  }

  function serializeCanvasForExport(bounds) {
    const source = dom.canvas;
    const clone = source.cloneNode(true);

    // Стили копируем до очистки клона: так индексы элементов ещё совпадают.
    inlineComputedStyles(source, clone);

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(bounds.width));
    clone.setAttribute('height', String(bounds.height));
    // Сбрасываем масштаб/панораму и задаём viewBox по габариту всех элементов.
    clone.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);

    // Убираем элементы интерфейса, которые не являются частью схемы:
    // превью провода, порты (теперь внутри модулей), кнопки удаления,
    // хало и индикаторы выделения.
    clone.querySelectorAll([
      '.wire-preview',
      '.port',
      '#canvas-hit-area',
      '[data-delete-module]',
      '[data-delete-wire]',
      '[data-delete-rail]',
      '[data-rail-capacity]',
      '.rail-cap-control',
      '.wire-halo',
      '.module-focus-ring',
      '.module-pending-badge',
      '.rail-overflow-outline',
      '.rail-slot-highlight',
      '.note-delete'
    ].join(', ')).forEach((element) => element.remove());

    return new XMLSerializer().serializeToString(clone);
  }

  /* ---------- Клон холста для полного печатного документа ----------
     Клон остаётся в том же HTML-документе, поэтому простого копирования
     недостаточно: ссылки url(#gradient) будут ссылаться на скрытый
     оригинал. Переименовываем ID в клоне и все ссылки на них, а ссылки,
     заданные CSS-правилами, переносим в инлайн-стили клона. */

  const PRINT_DEF_PREFIX = 'fp-print-';

  function rewritePrintRefs(value, attributeName) {
    let result = String(value);
    if (/^(href|xlink:href)$/i.test(attributeName || '') && result.startsWith('#')) {
      return `#${PRINT_DEF_PREFIX}${result.slice(1)}`;
    }
    return result.replace(/url\((['"]?)#([^)'"]+)\1\)/g,
      (_match, quote, id) => `url(${quote}#${PRINT_DEF_PREFIX}${id}${quote})`);
  }

  function cloneCanvasForPrint() {
    if (!dom.canvas) return null;
    try {
      const { width, height } = baseCanvasSize();
      const bounds = exportBounds(width, height);
      const source = dom.canvas;
      const clone = source.cloneNode(true);

      // IDdefs становятся уникальными, чтобы градиенты и фильтры клона
      // не подменялись одноимёнными из скрытого оригинального SVG.
      clone.querySelectorAll('[id]').forEach((element) => {
        element.setAttribute('id', PRINT_DEF_PREFIX + element.getAttribute('id'));
      });

      // Прямые ссылки в атрибутах: fill="url(#rail-holes)", filter, href и т.д.
      clone.querySelectorAll('*').forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
          const next = rewritePrintRefs(attribute.value, attribute.name);
          if (next !== attribute.value) element.setAttribute(attribute.name, next);
        }
      });

      // Ссылки из CSS-правил (.canvas-surface, .busbar-body--n и др.):
      // getComputedStyle возвращает абсолютный URL, поэтому сначала
      // локализуем его, затем переименовываем ID.
      const sourceElements = [source, ...source.querySelectorAll('*')];
      const cloneElements = [clone, ...clone.querySelectorAll('*')];
      sourceElements.forEach((element, index) => {
        const target = cloneElements[index];
        if (!target) return;
        const computed = window.getComputedStyle(element);
        for (const property of ['fill', 'stroke', 'filter', 'flood-color']) {
          const value = computed.getPropertyValue(property);
          if (!value.includes('url(')) continue;
          const local = localSvgUrl(value);
          if (!local.includes('url(#')) continue;
          target.style.setProperty(property, rewritePrintRefs(local));
        }
      });

      // Служебные элементы интерфейса в печатную схему не попадают.
      clone.querySelectorAll([
        '#canvas-hit-area',
        '#selection-box',
        '.wire-preview',
        '.port',
        '[data-delete-module]',
        '[data-delete-wire]',
        '[data-delete-rail]',
        '[data-rail-capacity]',
        '.rail-cap-control',
        '.wire-halo',
        '.module-focus-ring',
        '.module-pending-badge',
        '.rail-overflow-outline',
        '.rail-slot-highlight',
        '.note-delete'
      ].join(', ')).forEach((element) => element.remove());

      clone.removeAttribute('id');
      clone.setAttribute('class', `${clone.getAttribute('class') || ''} fp-scheme-svg`.trim());
      clone.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
      clone.setAttribute('width', String(bounds.width));
      clone.setAttribute('height', String(bounds.height));
      clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      clone.setAttribute('role', 'img');
      clone.setAttribute('aria-label', `Схема щита: ${project?.name || 'Новый щит'}`);
      return clone;
    } catch (error) {
      console.error('Full print: failed to clone canvas', error);
      return null;
    }
  }

  function exportPng() {
    let markup;
    let bounds;
    let width;
    let height;

    try {
      stabilizeCanvasForExport();
      ({ width, height } = baseCanvasSize());
      bounds = exportBounds(width, height);
      markup = serializeCanvasForExport(bounds);
    } catch (error) {
      console.error('PNG export preparation failed:', error);
      showToast('Не удалось подготовить изображение холста.', 'error', 3500);
      return;
    }

    const svgUrl = URL.createObjectURL(new Blob([markup], {
      type: 'image/svg+xml;charset=utf-8'
    }));
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(svgUrl);
      try {
        const canvas = document.createElement('canvas');
        const imageWidth = Math.ceil(bounds.width + EXPORT_PADDING * 2);
        const imageHeight = Math.ceil(bounds.height + EXPORT_PADDING * 2);

        canvas.width = Math.round(imageWidth * EXPORT_SCALE);
        canvas.height = Math.round(imageHeight * EXPORT_SCALE);

        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');

        const rootStyles = window.getComputedStyle(document.documentElement);
        const background = rootStyles.getPropertyValue('--canvas-bg').trim() ||
          rootStyles.getPropertyValue('--canvas-top').trim() ||
          '#0b1220';

        context.scale(EXPORT_SCALE, EXPORT_SCALE);
        context.fillStyle = background;
        context.fillRect(0, 0, imageWidth, imageHeight);
        context.drawImage(image, EXPORT_PADDING, EXPORT_PADDING, bounds.width, bounds.height);

        const save = (blob) => {
          if (!blob) {
            showToast('Не удалось создать PNG-файл.', 'error', 3500);
            return;
          }
          downloadBlob(blob, `${safeFileName(project.name)}-${fileDate()}.png`);
          showToast('Изображение холста скачано в PNG', 'success', 2800);
        };

        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob(save, 'image/png');
        } else {
          const dataUrl = canvas.toDataURL('image/png');
          const link = document.createElement('a');
          link.href = dataUrl;
          link.download = `${safeFileName(project.name)}-${fileDate()}.png`;
          link.click();
          showToast('Изображение холста скачано в PNG', 'success', 2800);
        }
      } catch (error) {
        console.error('PNG export failed:', error);
        showToast('Не удалось отрисовать изображение.', 'error', 3500);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      showToast('Не удалось прочитать SVG-холст.', 'error', 3500);
    };

    image.src = svgUrl;
  }

  /* ------------------------------ Toasts ------------------------------ */

  function showToast(message, type = 'success', duration = 2800) {
    if (!dom.toastRegion) return;

    while (dom.toastRegion.children.length >= 3) {
      dom.toastRegion.firstElementChild?.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    dom.toastRegion.appendChild(toast);

    window.setTimeout(() => {
      toast.classList.add('is-leaving');
      window.setTimeout(() => toast.remove(), 220);
    }, duration);
  }

  function flashCanvasError() {
    dom.canvasShell.classList.remove('is-error');
    // Force a reflow so the animation can restart after repeated attempts.
    void dom.canvasShell.offsetWidth;
    dom.canvasShell.classList.add('is-error');
    window.setTimeout(() => dom.canvasShell.classList.remove('is-error'), 650);
  }

  /* --------------------------- Project name --------------------------- */

  function onProjectNameInput() {
    project.name = dom.projectName.value.slice(0, 60);
    persistProject();
    updateDocumentTitle();
  }

  function onProjectNameBlur() {
    const normalizedName = dom.projectName.value.trim().slice(0, 60) || 'Новый щит';
    project.name = normalizedName;
    dom.projectName.value = normalizedName;
    persistProject();
    updateDocumentTitle();
  }

  /* ----------------- Выпадающие меню «Документы» и «Файл» ----------------- */

  // Меню позиционируются от своих кнопок, но сами имеют position: fixed:
  // так они перекрывают контент снизу и не растягивают шапку.
  const topbarMenus = [
    { dropdown: dom.documentsDropdown, trigger: dom.documentsMenuBtn, menu: dom.documentsMenu },
    { dropdown: dom.exportDropdown, trigger: dom.exportMenuBtn, menu: dom.exportMenu }
  ];

  function positionTopbarMenu(entry) {
    if (!entry?.menu || entry.menu.hidden || !entry.trigger) return;
    const triggerRect = entry.trigger.getBoundingClientRect();
    const menuWidth = entry.menu.offsetWidth;
    const left = Math.min(
      Math.max(8, triggerRect.right - menuWidth),
      Math.max(8, window.innerWidth - menuWidth - 8)
    );
    entry.menu.style.top = `${triggerRect.bottom + 8}px`;
    entry.menu.style.left = `${left}px`;
  }

  function setTopbarMenu(entry, open) {
    if (!entry?.menu || !entry.trigger) return;
    // Одновременно открыто только одно меню.
    topbarMenus.forEach((other) => {
      if (other === entry) return;
      if (other.menu) other.menu.hidden = true;
      other.trigger?.setAttribute('aria-expanded', 'false');
    });
    entry.menu.hidden = !open;
    entry.trigger.setAttribute('aria-expanded', String(open));
    if (open) positionTopbarMenu(entry);
  }

  /* ----------------------------- Bindings ----------------------------- */

  function bindEvents() {
    dom.libraryList.addEventListener('pointerdown', onLibraryPointerDown);
    dom.libraryList.addEventListener('click', onLibraryClick);
    dom.libraryList.addEventListener('click', onLibrarySummaryClick);
    dom.librarySearch.addEventListener('input', onLibrarySearchInput);
    dom.librarySearch.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dom.librarySearch.value) {
        event.preventDefault();
        event.stopPropagation();
        clearLibrarySearch();
      }
    });
    dom.librarySearchClear.addEventListener('click', clearLibrarySearch);

    // Capture на обёртке: панорамирование (Пробел + ЛКМ) перехватывает жест
    // раньше обработчиков модулей/портов на самом SVG.
    dom.svgWrap.addEventListener('pointerdown', onPanPointerDown, { capture: true });
    // Средняя кнопка обрабатывается именно через mousedown: только так
    // preventDefault() остановит системный автоскролл до его запуска.
    // Слушатель висит на обёртке, а не только на <svg>: в ней гарантированно
    // ловятся клики по всей площади холста, включая область вне пластины при
    // зуме < 100% (дополнительно страхует canvas-hit-area внутри SVG).
    dom.svgWrap.addEventListener('mousedown', onPanMouseDown, { capture: true });
    dom.svgWrap.addEventListener('wheel', onCanvasWheel, { passive: false });
    // Запоминаем точку курсора в координатах схемы — сюда вставляется буфер
    // по Ctrl+V (и это же место используется меню «Вставить»).
    dom.svgWrap.addEventListener('pointermove', (event) => {
      if (!project) return;
      lastPointerSvgPoint = getSVGCoords(event);
    }, { passive: true });
    dom.svgWrap.addEventListener('auxclick', (event) => {
      if (event.button === 1) event.preventDefault(); // без автопрокрутки браузера
    });
    if (dom.zoomInBtn) dom.zoomInBtn.addEventListener('click', () => zoomByStep(VIEW_ZOOM_STEP));
    if (dom.zoomOutBtn) dom.zoomOutBtn.addEventListener('click', () => zoomByStep(1 / VIEW_ZOOM_STEP));
    if (dom.resetViewBtn) dom.resetViewBtn.addEventListener('click', resetView);

    // Панель слоёв: сворачивание и переключатели «глаз» / «замок».
    if (dom.layersToggle) {
      dom.layersToggle.addEventListener('click', () => toggleLayersPanel());
    }
    if (dom.layersList) {
      dom.layersList.addEventListener('click', (event) => {
        const button = event.target.closest?.('.layer-toggle');
        if (!button || !dom.layersList.contains(button)) return;
        event.stopPropagation();
        setLayerSetting(button.dataset.layer, button.dataset.layerAction);
      });
    }
    if (dom.layersPanel) {
      // Панель — интерфейсный оверлей: колесо и клики на ней не должны
      // попадать в обработчики зума/панорамирования холста.
      ['mousedown', 'pointerdown', 'dblclick', 'auxclick'].forEach((type) => {
        dom.layersPanel.addEventListener(type, (event) => event.stopPropagation());
      });
      dom.layersPanel.addEventListener('wheel', (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, { passive: false });
    }

    dom.canvas.addEventListener('pointerdown', onCanvasPointerDown);
    // Рамка выделения начинается только на фоне; mousedown (а не pointerdown)
    // выбран намеренно: средняя кнопка/панорама уже перехватываются выше.
    dom.canvas.addEventListener('mousedown', onSelectionMouseDown);
    dom.canvas.addEventListener('click', onCanvasClick);
    // Подпись провода открывается двойным кликом именно по хало:
    // видимый .wire-path имеет pointer-events: none и событие не ловит.
    dom.wireLayer.addEventListener('dblclick', onWireDblClick);
    if (dom.notesLayer) dom.notesLayer.addEventListener('dblclick', onNoteDblClick);
    dom.canvas.addEventListener('dblclick', onCanvasDblClick);
    dom.canvas.addEventListener('keydown', onCanvasKeyDown);
    if (dom.inlineEditor) {
      const editor = dom.inlineEditor;
      // Клик по полю — отдельный жест: он не должен доходить до холста
      // (панорамирование, выбор порта, перетаскивание модуля).
      editor.addEventListener('pointerdown', onInlineEditorPointerDown);
      editor.addEventListener('dblclick', (event) => event.stopPropagation());
      editor.addEventListener('keydown', onInlineEditorKeyDown);
      // Клик мимо поля сохраняет текст так же, как Enter.
      editor.addEventListener('blur', () => {
        if (editing) commitInlineEdit();
      });
    }
    // Слой модулей перехватывает клики/клавиши по рычажкам до обработчика холста.
    dom.moduleLayer.addEventListener('click', onModuleToggleClick);
    dom.moduleLayer.addEventListener('dblclick', onModuleDblClick);
    dom.moduleLayer.addEventListener('keydown', onModuleToggleKeyDown);

    // Порты лежат внутри корпусов: слушаем слой модулей и группу источника.
    dom.moduleLayer.addEventListener('pointerover', onPortPointerOver);
    dom.moduleLayer.addEventListener('pointerout', onPortPointerOut);
    if (dom.powerSourceLayer) {
      dom.powerSourceLayer.addEventListener('pointerover', onPortPointerOver);
      dom.powerSourceLayer.addEventListener('pointerout', onPortPointerOut);
    }
    dom.canvas.addEventListener('pointerover', onElementPointerOver);
    dom.canvas.addEventListener('pointerout', onElementPointerOut);

    dom.wireTypePopover.addEventListener('click', onWireTypeOptionClick);
    dom.wireTypeCancel.addEventListener('click', () => {
      if (!pendingWire) return;
      pendingWire = null; // первый порт остаётся активным
      renderAll();
    });
    document.addEventListener('pointerdown', onDocumentPointerDown);

    // Контекстное меню холста: ПКМ по модулю / проводу / пустому месту.
    document.addEventListener('contextmenu', (event) => {
      if (!event.target.closest?.('#svg-wrap')) {
        closeContextMenu(); // вне холста остаётся системное меню
        return;
      }
      onContextMenu(event);
    });
    // Меню привязано к точке на экране: при прокрутке/изменении размера окна
    // его проще закрыть, чем пересчитывать привязку к элементу.
    // Без capture: прокрутка вложенных панелей (например, библиотеки) не должна
    // захлопывать меню, привязанное к точке на экране.
    window.addEventListener('scroll', () => closeContextMenu());
    window.addEventListener('resize', () => closeContextMenu());

    dom.migrationBannerClose.addEventListener('click', () => {
      dom.migrationBanner.hidden = true;
    });

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointermove', onPanPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointerup', endPan);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('pointercancel', endPan);
    // Панорамирование колесиком живёт на mouse-событиях window: жест корректно
    // завершится, даже если курсор ушёл за пределы холста/окна.
    window.addEventListener('mousemove', onPanMouseMove, { passive: false });
    window.addEventListener('mousemove', onSelectionMouseMove);
    window.addEventListener('mouseup', onPanMouseUp);
    window.addEventListener('mouseup', onSelectionMouseUp);
    document.addEventListener('mouseleave', () => {
      endPan();
      cancelSelectionBox();
    });
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('keydown', onGlobalKeyDown);
    document.addEventListener('keyup', onGlobalKeyUp);

    dom.connectionList.addEventListener('click', onConnectionsListClick);
    dom.cancelConnect.addEventListener('click', () => {
      if (!activePort && !pendingWire) return;
      clearConnectionDraft();
      renderAll();
    });

    dom.projectName.addEventListener('input', onProjectNameInput);
    dom.projectName.addEventListener('blur', onProjectNameBlur);

    if (dom.simulationToggle) {
      dom.simulationToggle.addEventListener('change', onSimulationToggleChange);
    }
    if (dom.paramsToggle) {
      dom.paramsToggle.addEventListener('change', onParamsToggleChange);
    }
    if (dom.addRail) dom.addRail.addEventListener('click', addRail);
    if (dom.addNoteBtn) {
      dom.addNoteBtn.addEventListener('click', () => setNotePlacing(!notePlacing));
    }
    dom.undoBtn.addEventListener('click', undo);
    dom.redoBtn.addEventListener('click', redo);
    if (dom.groupBtn) dom.groupBtn.addEventListener('click', groupSelectedModules);
    if (dom.ungroupBtn) dom.ungroupBtn.addEventListener('click', ungroupSelectedModules);
    dom.exportCsv.addEventListener('click', exportCsv);
    dom.exportCsvSecondary.addEventListener('click', exportCsv);
    dom.exportPng.addEventListener('click', exportPng);
    if (dom.fullPdfBtn) dom.fullPdfBtn.addEventListener('click', printFullProject);
    if (dom.downloadProject) dom.downloadProject.addEventListener('click', exportProject);

    // Выпадающие меню шапки: открытие по клику, закрытие по клику на пункт,
    // кликом вне меню и по Escape. При скролле/ресайзе позиция пересчитывается.
    topbarMenus.forEach((entry) => {
      if (!entry.trigger || !entry.menu) return;
      entry.trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        setTopbarMenu(entry, entry.menu.hidden);
      });
      if (entry.dropdown) {
        entry.dropdown.addEventListener('click', (event) => {
          if (event.target.closest?.('.topbar-menu-item')) setTopbarMenu(entry, false);
        });
      }
    });
    document.addEventListener('click', (event) => {
      topbarMenus.forEach((entry) => {
        if (!entry.menu || entry.menu.hidden) return;
        if (entry.dropdown?.contains(event.target)) return;
        setTopbarMenu(entry, false);
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const openMenu = topbarMenus.find((entry) => entry.menu && !entry.menu.hidden);
      if (!openMenu) return;
      setTopbarMenu(openMenu, false);
      openMenu.trigger?.focus();
    });
    window.addEventListener('resize', () => topbarMenus.forEach((entry) => positionTopbarMenu(entry)));
    window.addEventListener('scroll', () => topbarMenus.forEach((entry) => positionTopbarMenu(entry)), true);

    if (dom.importProject) dom.importProject.addEventListener('click', openImportFileDialog);
    if (dom.importFile) dom.importFile.addEventListener('change', onImportFileChange);

    // Авторизация: вход, регистрация и выход.
    if (dom.authForm) {
      dom.authForm.addEventListener('submit', (event) => {
        event.preventDefault();
        signInWithEmail();
      });
    }
    if (dom.authSignupBtn) dom.authSignupBtn.addEventListener('click', signUpWithEmail);
    if (dom.authLogin) dom.authLogin.addEventListener('click', showAuthDialog);
    if (dom.authLogout) dom.authLogout.addEventListener('click', signOutUser);
    [dom.authEmailInput, dom.authPasswordInput].forEach((input) => {
      if (input) input.addEventListener('input', clearAuthError);
    });

    // Облачные проекты: сохранение, загрузка и диалог выбора.
    if (dom.cloudSave) dom.cloudSave.addEventListener('click', saveProjectToCloud);
    if (dom.cloudLoad) dom.cloudLoad.addEventListener('click', openCloudProjectDialog);
    if (dom.cloudDialogClose) {
      dom.cloudDialogClose.addEventListener('click', () => dom.cloudDialog.close());
    }
    if (dom.cloudDialogCancel) {
      dom.cloudDialogCancel.addEventListener('click', () => dom.cloudDialog.close());
    }
    if (dom.cloudDialog) {
      dom.cloudDialog.addEventListener('click', (event) => {
        if (event.target === dom.cloudDialog) dom.cloudDialog.close();
      });
    }

    dom.clearProject.addEventListener('click', openClearDialog);
    dom.clearDialog.addEventListener('close', onClearDialogClose);

    // Кабельный журнал из шапки: переключаемся на вкладку и поднимаем её в вид.
    if (dom.openJournal) {
      dom.openJournal.addEventListener('click', () => {
        switchViewTab('journal');
        dom.journalView?.scrollIntoView({ block: 'start' });
      });
    }

    // Маркировка из шапки — отдельная вкладка, как кабельный журнал.
    if (dom.openMarking) {
      dom.openMarking.addEventListener('click', () => {
        switchViewTab('marking');
        dom.markingView?.scrollIntoView({ block: 'start' });
      });
    }
    if (dom.markingAutonumber) dom.markingAutonumber.addEventListener('click', autoNumberMarkings);
    if (dom.markingExportJson) dom.markingExportJson.addEventListener('click', exportMarkingJson);
    // «Печать» печатает активный режим: ленту или лист наклеек.
    if (dom.markingPrint) dom.markingPrint.addEventListener('click', printActiveMarking);
    if (dom.markingPdf) dom.markingPdf.addEventListener('click', printActiveMarking);
    if (dom.markingDownload) dom.markingDownload.addEventListener('click', downloadTape);
    if (dom.markingReset) dom.markingReset.addEventListener('click', resetMarkings);

    // Переключатель режимов редактора маркировки.
    document.querySelectorAll('[data-marking-mode]').forEach((button) => {
      button.addEventListener('click', () => setMarkingMode(button.dataset.markingMode));
    });

    // Библиотека значков: клик по иконке, затем по ячейке на ленте.
    if (dom.markingToolsList) {
      dom.markingToolsList.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-tape-icon]');
        if (button && dom.markingToolsList.contains(button)) applyTapeIcon(button.dataset.tapeIcon);
      });
    }
    if (dom.markingToolClear) {
      dom.markingToolClear.addEventListener('click', () => {
        tapePendingIcon = null;
        updateTapeToolsState();
        const marking = markings().find((item) => item.id === selectedTapeMarkingId);
        if (!marking) {
          showToast('Ячейка не выбрана', 'error', 1800);
          return;
        }
        marking.icon = 'none';
        commitMarkingChange('Значок снят');
      });
    }

    // Лента: выбор ячейки и применение отложенного значка.
    if (dom.markingTape) {
      dom.markingTape.addEventListener('click', (event) => {
        const cell = event.target.closest?.('[data-marking-id]');
        if (!cell || !dom.markingTape.contains(cell)) return;
        selectTapeMarking(cell.dataset.markingId);
      });
    }

    // Свойства: тег и описание меняются мгновенно, в историю пишутся по blur.
    let tapeTextDraft = null;
    const bindTapeText = (input, field) => {
      if (!input) return;
      input.addEventListener('input', () => {
        if (!selectedTapeMarkingId) return;
        const marking = markings().find((item) => item.id === selectedTapeMarkingId);
        const module = marking?.kind === 'module' ? moduleById(marking.refId) : null;
        if (!module) return;
        module[field] = field === 'tag'
          ? String(input.value || '').trim().slice(0, 12).toUpperCase()
          : String(input.value || '').slice(0, MAX_MODULE_DESCRIPTION_LENGTH);
        tapeTextDraft = { markingId: selectedTapeMarkingId, field };
        renderTape();
      });
      input.addEventListener('change', () => {
        if (tapeTextDraft && tapeTextDraft.markingId) {
          tapeTextDraft = null;
          commitMarkingChange(field === 'tag' ? 'Тег обновлён' : 'Описание обновлено');
        }
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        }
      });
    };
    bindTapeText(dom.tapeTagInput, 'tag');
    bindTapeText(dom.tapeDescInput, 'description');

    if (dom.tapeIconPicker) {
      dom.tapeIconPicker.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-icon]');
        if (button) applyTapeIcon(button.dataset.icon);
      });
    }
    if (dom.tapeColorSwatches) {
      dom.tapeColorSwatches.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-color]');
        if (button) applyTapeColor(button.dataset.color);
      });
    }
    if (dom.tapeColorCustom) {
      dom.tapeColorCustom.addEventListener('change', () => applyTapeColor(dom.tapeColorCustom.value));
    }
    if (dom.tapeMergeCheck) {
      dom.tapeMergeCheck.addEventListener('change', () => setTapeMerge(dom.tapeMergeCheck.checked));
    }
    if (dom.tapeResetCell) dom.tapeResetCell.addEventListener('click', resetTapeCell);

    // Настройки листа: каждое изменение сохраняется в проект и попадает
    // в историю Undo/Redo.
    [dom.markingSize, dom.markingOrientation, dom.markingMarginTop,
      dom.markingMarginRight, dom.markingMarginBottom, dom.markingMarginLeft,
      dom.markingRulerToggle, dom.markingPrintLegend].forEach((input) => {
      if (input) input.addEventListener('change', onMarkingSettingChange);
    });

    // Наклейка в предпросмотре открывает встроенный редактор рядом с ней.
    if (dom.markingSheetArea) {
      dom.markingSheetArea.addEventListener('click', (event) => {
        const sticker = event.target.closest?.('[data-marking-id]');
        if (!sticker || !dom.markingSheetArea.contains(sticker)) return;
        openMarkingEditor(sticker.dataset.markingId, sticker);
      });
    }

    // Клик по модулю на схеме тоже открывает редактор его наклейки.
    let modulePointerDown = null;
    if (dom.moduleLayer) {
      dom.moduleLayer.addEventListener('pointerdown', (event) => {
        modulePointerDown = { x: event.clientX, y: event.clientY };
      });
      dom.moduleLayer.addEventListener('click', (event) => {
        if (activeTab !== 'schema' || !modulePointerDown) return;
        const moved = Math.hypot(event.clientX - modulePointerDown.x,
          event.clientY - modulePointerDown.y);
        modulePointerDown = null;
        if (moved > 6 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.target.closest?.('[data-port-id], [data-toggle-module], [data-delete-module]')) return;
        const group = event.target.closest?.('[data-module-id]');
        if (!group) return;
        const module = moduleById(group.getAttribute('data-module-id'));
        if (!module) return;
        syncMarkings();
        persistProject();
        const marking = markings().find((item) =>
          item.kind === 'module' && item.refId === module.id);
        if (marking) openMarkingEditor(marking.id, group);
      });
    }

    // Встроенный редактор наклейки.
    if (dom.markingEditor) {
      dom.markingEditor.addEventListener('pointerdown', (event) => event.stopPropagation());
      dom.markingEditor.addEventListener('click', (event) => event.stopPropagation());
    }
    if (dom.markingEditorClose) dom.markingEditorClose.addEventListener('click', closeMarkingEditor);
    if (dom.markingMainInput) {
      dom.markingMainInput.addEventListener('change', () => updateMarkingFromEditor());
      dom.markingMainInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          updateMarkingFromEditor();
        }
      });
    }
    if (dom.markingTextMode) {
      dom.markingTextMode.addEventListener('change', () => {
        const marking = markings().find((item) => item.id === selectedMarkingId);
        if (!marking) return;
        marking.textMode = dom.markingTextMode.value;
        commitMarkingChange('Источник текста изменён', true);
        fillMarkingEditor(marking);
      });
    }
    if (dom.markingTextOrientation) {
      dom.markingTextOrientation.addEventListener('change', () => updateMarkingFromEditor());
    }
    if (dom.markingWidthMm) {
      dom.markingWidthMm.addEventListener('change', () => updateMarkingFromEditor());
    }
    if (dom.markingPreset) {
      dom.markingPreset.addEventListener('change', () => {
        if (!dom.markingWidthMm) return;
        dom.markingWidthMm.value = dom.markingPreset.value;
        updateMarkingFromEditor();
      });
    }
    if (dom.markingIconPicker) {
      dom.markingIconPicker.innerHTML = markingIconPickerHtml();
      dom.markingIconPicker.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-icon]');
        if (!button) return;
        const marking = markings().find((item) => item.id === selectedMarkingId);
        if (!marking) return;
        marking.icon = button.dataset.icon;
        commitMarkingChange('Пиктограмма обновлена');
        fillMarkingEditor(marking);
      });
    }
    if (dom.markingClone) dom.markingClone.addEventListener('click', () => cloneMarking());
    if (dom.markingGroup) dom.markingGroup.addEventListener('click', () => toggleMarkingGroup());
    if (dom.markingDelete) dom.markingDelete.addEventListener('click', () => deleteMarking());
    window.addEventListener('scroll', () => positionMarkingEditor(), true);
    window.addEventListener('resize', () => positionMarkingEditor());

    // Смета проекта.
    if (dom.openEstimate) dom.openEstimate.addEventListener('click', openEstimate);
    if (dom.estimateDialog) {
      dom.estimateDialog.addEventListener('click', (event) => {
        // Клик по затемнению вне окна закрывает смету.
        if (event.target === dom.estimateDialog) dom.estimateDialog.close();
      });
    }
    if (dom.estimateClose) {
      dom.estimateClose.addEventListener('click', () => dom.estimateDialog.close());
    }
    if (dom.estimateCloseBottom) {
      dom.estimateCloseBottom.addEventListener('click', () => dom.estimateDialog.close());
    }
    if (dom.estimateDownloadCsv) {
      dom.estimateDownloadCsv.addEventListener('click', exportEstimateCsv);
    }
    if (dom.estimatePrint) dom.estimatePrint.addEventListener('click', printEstimate);

    // Инлайн-редактор цены. Делегирование необходимо, потому что таблица
    // полностью перерисовывается после каждого сохранения.
    if (dom.estimateContent) {
      dom.estimateContent.addEventListener('click', (event) => {
        const cell = event.target.closest?.('.est-price');
        if (cell && dom.estimateContent.contains(cell)) startPriceEdit(cell);
      });
      dom.estimateContent.addEventListener('keydown', (event) => {
        const cell = event.target.closest?.('.est-price');
        if (!cell || event.target !== cell) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          startPriceEdit(cell);
        }
      });
    }
    // Вкладки рабочей области. Каждый переход в журнал пересобирает таблицу.
    if (dom.viewTabs) {
      dom.viewTabs.addEventListener('click', (event) => {
        const tab = event.target.closest?.('[data-view-tab]');
        if (tab && dom.viewTabs.contains(tab)) switchViewTab(tab.dataset.viewTab);
      });
      dom.viewTabs.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const order = ['schema', 'journal', 'marking'];
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const next = order[(order.indexOf(activeTab) + step + order.length) % order.length];
        switchViewTab(next);
        ({ schema: dom.tabSchema, journal: dom.tabJournal, marking: dom.tabMarking })[next]?.focus();
      });
    }

    // Кабельный журнал: экспорт и печать.
    if (dom.journalDownloadCsv) {
      dom.journalDownloadCsv.addEventListener('click', exportJournalCsv);
    }
    if (dom.journalPrint) dom.journalPrint.addEventListener('click', printJournal);

    // Примечания редактируются прямо в таблице. Делегирование необходимо:
    // tbody пересобирается после каждого изменения проекта.
    if (dom.journalBody) {
      dom.journalBody.addEventListener('pointerdown', (event) => {
        if (event.target.closest?.('.j-note-editable')) event.stopPropagation();
      });
      dom.journalBody.addEventListener('click', (event) => {
        const cell = event.target.closest?.('.j-note-editable');
        if (!cell || !dom.journalBody.contains(cell)) return;
        event.stopPropagation();
        startJournalNoteEdit(cell);
      });
      dom.journalBody.addEventListener('keydown', (event) => {
        const cell = event.target.closest?.('.j-note-editable');
        // Enter/Пробел открывают редактор только когда фокус на самой ячейке;
        // клавиши внутри <input> обрабатывает его собственный обработчик.
        if (!cell || event.target !== cell) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          startJournalNoteEdit(cell);
        }
      });
    }

    // Ctrl+P печатает актуальный лист даже без открытой вкладки. На вкладке
    // маркировки выводится лист наклеек, иначе — журнал или смета.
    window.addEventListener('beforeprint', () => {
      if (!project) return;
      if (printContext === 'full') {
        // Документ уже собран кнопкой; только восстанавливаем состояние
        // печати на случай повторного вызова диалога браузером.
        document.body.classList.add('print-full', 'print-marking');
        document.body.classList.remove('print-estimate', 'print-tape');
        updateMarkingPageStyle('marking');
        return;
      }
      const useTape = activeTab === 'marking' && markingMode === 'tape';
      const context = activeTab === 'marking' ? 'marking' : printContext;
      document.body.classList.toggle('print-tape', useTape);
      document.body.classList.toggle('print-marking', context === 'marking' && !useTape);
      document.body.classList.toggle('print-estimate', context === 'estimate');
      if (useTape) {
        renderTapePrintSheet();
        applyTapePageStyle();
      } else {
        if (context === 'marking') renderMarking();
        else if (context === 'estimate') renderEstimate();
        else renderJournal();
        updateMarkingPageStyle(context === 'marking' ? 'marking' : null);
      }
    });
    window.addEventListener('afterprint', () => {
      const wasFull = printContext === 'full';
      document.body.classList.remove('print-estimate');
      document.body.classList.remove('print-marking');
      document.body.classList.remove('print-tape');
      printContext = 'journal';
      dom.markingPageStyle.textContent = '';
      if (wasFull) clearFullPrintView();
      if (activeTab === 'marking') renderMarking();
    });
  }

  /* ------------------------------- Init ------------------------------- */

  async function init() {
    installVisualDefs();
    setupSvgLayerStructure();
    renderLibrary();
    bindEvents();
    ensureIconButtonTitles();
    switchViewTab('schema');
    bootProject();
    resetHistory();

    dom.projectName.value = project.name;
    updateDocumentTitle();
    syncSimulationToggle();
    syncParamsToggle();
    renderAll();

    // Редактор ленты: библиотека значков, палитра и режим по умолчанию.
    renderTapeTools();
    setMarkingMode('tape');

    // Баннер миграции показывается один раз: обновлённый проект уже записан в localStorage.
    const migrationText = dom.migrationBanner.querySelector('[data-migration-text]');
    if (migrationText) migrationText.textContent = migrationNotice;
    dom.migrationBanner.hidden = !showMigrationBanner;

    for (const [message, type] of bootNotices) {
      showToast(message, type, 5000);
    }

    // Проверяем сессию Supabase: без неё показываем окно входа и держим
    // облачные кнопки неактивными.
    await initAuth();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();