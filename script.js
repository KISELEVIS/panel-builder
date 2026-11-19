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

(() => {
  'use strict';

  /* ----------------------------- Constants ----------------------------- */

  // Ключ намеренно остаётся прежним: так старые проекты находятся и мигрируют.
  const STORAGE_KEY = 'panel-builder.project.v1';
  const SCHEMA_VERSION = 4;
  // История живёт только в памяти: в localStorage пишется лишь текущий проект.
  const HISTORY_LIMIT = 50;

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
  // Отступы вокруг холста и коэффициент чёткости для PNG-экспорта.
  const EXPORT_PADDING = 24;
  const EXPORT_SCALE = 2;

  const RAIL = Object.freeze({
    x: 50,
    y: 200,
    width: 916,
    height: 266,
    capacity: 18,
    moduleX: 74,
    moduleY: 250,
    moduleRight: 938
  });
  // Рейки стоят вертикально друг под другом; шаг включает запас на провода.
  const RAIL_GAP = 100;
  const RAIL_PITCH = RAIL.height + RAIL_GAP;
  const MAX_RAILS = 8;
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
    busbar: 'BUS'
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
  const PORT_LABELS = Object.freeze({ top: 'верх', bottom: 'низ' });
  const PORT_SIDES = Object.freeze(['top', 'bottom']);
  const PORT_RADIUS = 4;
  const PORT_HIT_RADIUS = 11;
  const WIRE_OFFSET = 30;
  const WIRE_LANE_GAP = 8;
  // Вертикальные коридоры для проводов, идущих с верхней грани на нижнюю.
  const WIRE_CORRIDOR_X = Object.freeze({ left: 40, right: 976 });
  const MIGRATION_NOTICE = 'Провода сброшены из-за обновления, проведите заново';

  // Fallback palette for unknown legacy modules; new modules use LIBRARY colors.
  const WIRE_COLORS = ['#2dd4bf', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#a3e635'];
  const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

  const LIBRARY_CATEGORIES = Object.freeze([
    { id: 'input-protection', label: 'Ввод и защита' },
    { id: 'differential', label: 'Дифференциальная защита' },
    { id: 'commutation', label: 'Коммутация' },
    { id: 'automation', label: 'Управление и автоматика' },
    { id: 'measurement', label: 'Измерение' },
    { id: 'terminals', label: 'Клеммы' }
  ]);

  const LIBRARY = Object.freeze([
    /* Ввод и защита */
    {
      id: 'incoming-breaker-2p',
      type: 'breaker',
      typeLabel: 'Автомат',
      category: 'input-protection',
      name: 'Вводной автомат 2P',
      width: 2,
      color: '#2563eb',
      tagPrefix: 'QF',
      ports: { top: 2, bottom: 2 },
      description: 'Главный ввод и защита двухполюсной линии.'
    },
    {
      id: 'incoming-breaker-3p',
      type: 'breaker',
      typeLabel: 'Автомат',
      category: 'input-protection',
      name: 'Вводной автомат 3P',
      width: 3,
      color: '#1d4ed8',
      tagPrefix: 'QF',
      ports: { top: 3, bottom: 3 },
      description: 'Вводной трёхполюсный автомат для трёхфазной сети.'
    },
    {
      id: 'breaker-1p',
      type: 'breaker',
      typeLabel: 'Автомат',
      category: 'input-protection',
      name: 'Автомат 1P C16',
      width: 1,
      color: '#3b82f6',
      tagPrefix: 'QF',
      ports: { top: 1, bottom: 1 },
      description: 'Однополюсная защитная линия 16 А, характеристика C.'
    },
    {
      id: 'breaker-1p-c25',
      type: 'breaker',
      typeLabel: 'Автомат',
      category: 'input-protection',
      name: 'Автомат 1P C25',
      width: 1,
      color: '#0ea5e9',
      tagPrefix: 'QF',
      ports: { top: 1, bottom: 1 },
      description: 'Однополюсная линия 25 А для более мощной нагрузки.'
    },
    {
      id: 'breaker-3p',
      type: 'breaker',
      typeLabel: 'Автомат',
      category: 'input-protection',
      name: 'Автомат 3P C32',
      width: 3,
      color: '#4f46e5',
      tagPrefix: 'QF',
      ports: { top: 3, bottom: 3 },
      description: 'Трёхполюсная защита 32 А для силовой линии.'
    },
    {
      id: 'rcbo-1pn',
      type: 'rcbo',
      typeLabel: 'Дифавтомат',
      category: 'input-protection',
      name: 'Дифавтомат 1P+N 16A/30mA',
      width: 2,
      color: '#7c3aed',
      tagPrefix: 'QF',
      ports: { top: 2, bottom: 2 },
      description: 'Автомат и УЗО в одном корпусе для влажных зон.'
    },

    /* Дифференциальная защита */
    {
      id: 'rcd',
      type: 'rcd',
      typeLabel: 'УЗО',
      category: 'differential',
      name: 'УЗО 2P 40A/30mA',
      width: 2,
      color: '#0f766e',
      tagPrefix: 'QS',
      ports: { top: 2, bottom: 2 },
      description: 'Двухполюсное УЗО для групповых линий.'
    },
    {
      id: 'rcd-4p',
      type: 'rcd',
      typeLabel: 'УЗО',
      category: 'differential',
      name: 'УЗО 4P 63A/30mA',
      width: 4,
      color: '#059669',
      tagPrefix: 'QS',
      ports: { top: 4, bottom: 4 },
      description: 'Четырёхполюсное УЗО для трёхфазной группы.'
    },

    /* Коммутация */
    {
      id: 'contactor',
      type: 'contactor',
      typeLabel: 'Контактор',
      category: 'commutation',
      name: 'Контактор 2P',
      width: 2,
      color: '#9333ea',
      tagPrefix: 'KM',
      ports: { top: 2, bottom: 2 },
      description: 'Двухполюсный контактор управления нагрузкой.'
    },
    {
      id: 'contactor-4p',
      type: 'contactor',
      typeLabel: 'Контактор',
      category: 'commutation',
      name: 'Контактор 4P',
      width: 4,
      color: '#a21caf',
      tagPrefix: 'KM',
      ports: { top: 4, bottom: 4 },
      description: 'Четырёхполюсный контактор для трёхфазных цепей.'
    },
    {
      id: 'voltage-relay',
      type: 'relay',
      typeLabel: 'Реле',
      category: 'commutation',
      name: 'Реле напряжения',
      width: 1,
      color: '#dc2626',
      tagPrefix: 'KV',
      ports: { top: 2, bottom: 2 },
      description: 'Защита оборудования от скачков напряжения.'
    },
    {
      id: 'load-priority-relay',
      type: 'relay',
      typeLabel: 'Реле',
      category: 'commutation',
      name: 'Реле приоритета нагрузки',
      width: 2,
      color: '#e11d48',
      tagPrefix: 'KV',
      ports: { top: 2, bottom: 2 },
      description: 'Отключает второстепенную нагрузку при перегрузке.'
    },

    /* Управление и автоматика */
    {
      id: 'astro-timer',
      type: 'timer',
      typeLabel: 'Таймер',
      category: 'automation',
      name: 'Астротаймер',
      width: 2,
      color: '#d97706',
      tagPrefix: 'KT',
      ports: { top: 2, bottom: 2 },
      description: 'Включает освещение по астрономическому расписанию.'
    },
    {
      id: 'impulse-relay',
      type: 'impulse-relay',
      typeLabel: 'Импульсное реле',
      category: 'automation',
      name: 'Импульсное реле',
      width: 1,
      color: '#ea580c',
      tagPrefix: 'KV',
      ports: { top: 1, bottom: 1 },
      description: 'Управление светом с нескольких кнопок.'
    },
    {
      id: 'power-supply-24v',
      type: 'power-supply',
      typeLabel: 'Блок питания',
      category: 'automation',
      name: 'Блок питания 24V',
      width: 4,
      color: '#ca8a04',
      tagPrefix: 'GB',
      ports: { top: 2, bottom: 2 },
      description: 'Питание слаботочных устройств и автоматики.'
    },

    /* Измерение */
    {
      id: 'voltmeter',
      type: 'voltmeter',
      typeLabel: 'Вольтметр',
      category: 'measurement',
      name: 'Вольтметр на DIN',
      width: 2,
      color: '#db2777',
      tagPrefix: 'PV',
      ports: { top: 2, bottom: 2 },
      description: 'Контроль напряжения в щите на лицевой панели.'
    },
    {
      id: 'multifunction-meter',
      type: 'meter',
      typeLabel: 'Счётчик',
      category: 'measurement',
      name: 'Многофункциональный счётчик',
      width: 6,
      color: '#be185d',
      tagPrefix: 'PI',
      ports: { top: 4, bottom: 4 },
      description: 'Учёт электроэнергии и параметров сети.'
    },

    /* Клеммы */
    {
      id: 'terminal',
      type: 'terminal',
      typeLabel: 'Клеммы',
      category: 'terminals',
      name: 'Клеммник 4 мм²',
      width: 2,
      color: '#4d7c0f',
      tagPrefix: 'XT',
      ports: { top: 1, bottom: 1 },
      description: 'Проходные клеммы для проводников до 4 мм².'
    },
    {
      id: 'terminal-10mm',
      type: 'terminal',
      typeLabel: 'Клеммы',
      category: 'terminals',
      name: 'Клеммник 10 мм²',
      width: 2,
      color: '#65a30d',
      tagPrefix: 'XT',
      ports: { top: 1, bottom: 1 },
      description: 'Силовые клеммы для проводников до 10 мм².'
    },
    {
      id: 'busbar-n',
      type: 'busbar',
      typeLabel: 'Шина N',
      category: 'terminals',
      name: 'Шина N (ноль)',
      width: 6,
      color: '#3b82f6',
      tagPrefix: 'XN',
      ports: { top: 6, bottom: 6 },
      isBusbar: true,
      busbarType: 'N',
      description: 'Медная шина нуля на 6 клемм: ток, пришедший на любой порт, растекается по всей шине. Подключаются только провода N.'
    },
    {
      id: 'busbar-pe',
      type: 'busbar',
      typeLabel: 'Шина PE',
      category: 'terminals',
      name: 'Шина PE (земля)',
      width: 6,
      color: '#65a30d',
      tagPrefix: 'XP',
      ports: { top: 6, bottom: 6 },
      isBusbar: true,
      busbarType: 'PE',
      description: 'Серебристая шина заземления на 6 клемм: все порты становятся активными одновременно. Подключаются только провода PE.'
    },
    {
      id: 'bus-connector',
      type: 'busbar',
      typeLabel: 'Шинный',
      category: 'terminals',
      name: 'Шинный соединитель',
      width: 1,
      color: '#0d9488',
      tagPrefix: 'XT',
      ports: { top: 1, bottom: 1 },
      description: 'Соединяет соседние клеммы общей шиной.'
    }
  ]);

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
    busbar: 'Шинный'
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
    exportCsv: document.getElementById('export-csv'),
    exportCsvSecondary: document.getElementById('export-csv-secondary'),
    exportPng: document.getElementById('export-png'),
    zoomInBtn: document.getElementById('zoom-in'),
    zoomOutBtn: document.getElementById('zoom-out'),
    zoomLevel: document.getElementById('zoom-level'),
    resetViewBtn: document.getElementById('reset-view'),
    simulationToggle: document.getElementById('simulation-toggle'),
    simulationState: document.getElementById('simulation-state'),
    clearProject: document.getElementById('clear-project'),
    canvasShell: document.getElementById('canvas-shell'),
    canvas: document.getElementById('panel-canvas'),
    canvasSurface: document.getElementById('canvas-surface'),
    canvasGrid: document.getElementById('canvas-grid'),
    svgWrap: document.getElementById('svg-wrap'),
    railLayer: document.getElementById('layer-rail'),
    sourceLayer: document.getElementById('layer-source'),
    wireLayer: document.getElementById('layer-wires'),
    moduleLayer: document.getElementById('layer-modules'),
    portLayer: document.getElementById('layer-ports'),
    previewLayer: document.getElementById('layer-preview'),
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
    connectionsCount: document.getElementById('connections-count'),
    connectionList: document.getElementById('connection-list'),
    clearDialog: document.getElementById('clear-dialog'),
    toastRegion: document.getElementById('toast-region')
  };

  /* ------------------------------ State ------------------------------- */

  let project = null;
  let activePort = null;       // { moduleId, side, index } — первый выбранный порт
  let pendingWire = null;      // { moduleId, side, index } — второй порт, ждём тип L1…PE
  // Множество портов под напряжением, посчитанное calculatePowerFlow().
  // Используется рендером для подсветки клемм шин.
  let livePorts = new Set();
  let selectedConnectionId = null;
  let gesture = null;
  let dragState = null;
  // Состояние viewBox: x/y — левый верхний угол в координатах схемы,
  // zoom — коэффициент масштаба (1 = 100%).
  const viewState = { x: 0, y: 0, zoom: 1 };
  let panState = null;
  let spaceHeld = false;
  let renderScheduled = false;
  let suppressCanvasClickUntil = 0;
  let storageErrorAnnounced = false;
  let isLibraryFiltering = false;
  let showMigrationBanner = false;
  // Снимки только реек и связей: название проекта и прочие метаданные
  // не должны «откатываться» вместе со структурой щита.
  let history = [];
  let historyIndex = -1;
  const libraryOpenState = new Set([LIBRARY_CATEGORIES[0].id]);
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

  function sumWidths(modules) {
    return modules.reduce((total, module) => total + module.width, 0);
  }

  function allModules() {
    return project.rails.reduce((modules, rail) => modules.concat(rail.modules), []);
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

  function canvasHeight() {
    return SVG_BASE_HEIGHT + railOffsetY(project.rails.length - 1);
  }

  function railWithRoom(width) {
    return project.rails.find((rail) => rail.capacity - usedWidth(rail) >= width) || project.rails[0];
  }

  function railOfModule(moduleId) {
    for (const rail of project.rails) {
      const module = rail.modules.find((item) => item.id === moduleId);
      if (module) return { rail, module, index: railIndexOf(rail.id) };
    }
    return null;
  }

  function sourcePortPoint(index) {
    const count = POWER_SOURCE.ports.length;
    return {
      x: POWER_SOURCE.x + ((index + 1) * POWER_SOURCE.width) / (count + 1),
      y: POWER_SOURCE.y + POWER_SOURCE.height
    };
  }

  function isPowerSourcePort(ref) {
    return Boolean(ref) && ref.moduleId === POWER_SOURCE.id;
  }

  /* --------------------------- Busbars (шины) -------------------------- */

  // Тип шины (N / PE) хранится в самом модуле; для старых сохранений он
  // восстанавливается по записи библиотеки.
  function busbarTypeOf(module) {
    if (module?.busbarType === 'N' || module?.busbarType === 'PE') return module.busbarType;
    const libraryType = LIBRARY_BY_ID.get(module?.libraryId)?.busbarType;
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
    return MODULE_BRANDS[module?.type] || 'DINPRO';
  }

  function moduleHasSwitch(module) {
    return SWITCHABLE_MODULE_TYPES.has(module?.type);
  }

  function truncateLabel(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1).trimEnd()}…`;
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

  // Визуальный порядок слоёв: провода должны лежать поверх корпусов,
  // но под портами — так кабели остаются яркими и чёткими.
  function promoteWireLayer() {
    const { canvas, wireLayer, moduleLayer, portLayer } = dom;
    if (!canvas || !wireLayer || !moduleLayer || !portLayer) return;
    if (moduleLayer.nextElementSibling !== wireLayer) {
      canvas.insertBefore(wireLayer, portLayer);
    }
  }

  function portsForModule(module) {
    if (module?.isPowerSource || module?.id === POWER_SOURCE.id) {
      return { top: 0, bottom: POWER_SOURCE.ports.length };
    }
    const configured = module?.ports || LIBRARY_BY_ID.get(module?.libraryId)?.ports;
    if (configured) {
      return {
        top: clamp(Math.round(Number(configured.top) || 1), 1, 8),
        bottom: clamp(Math.round(Number(configured.bottom) || 1), 1, 8)
      };
    }
    // Legacy/unknown modules get at least one port per DIN unit.
    const fallback = clamp(Math.round(Number(module?.width) || 1), 1, 6);
    return { top: fallback, bottom: fallback };
  }

  function makePortId(moduleId, side, index) {
    return `${moduleId}:${side}:${index}`;
  }

  function isPortSide(value) {
    return value === 'top' || value === 'bottom';
  }

  function normalizePortIndex(value, module, side) {
    const count = portsForModule(module)[side] || 1;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? clamp(Math.round(parsed), 0, count - 1) : 0;
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
    return {
      moduleId,
      side,
      index,
      railId: position.railId || location?.rail.id || null,
      railIndex: Number.isInteger(position.railIndex) ? position.railIndex : (location?.index ?? 0),
      // Порты равномерно распределены по грани модуля (без углов).
      x: position.x + ((index + 1) * position.width) / (counts[side] + 1),
      y: side === 'top' ? position.y : position.y + MODULE_HEIGHT
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

    for (const connection of project.connections) {
      const fromPort = makePortId(
        connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex
      );
      const toPort = makePortId(
        connection.toModuleId, connection.toPortSide, connection.toPortIndex
      );
      connection.isLive = activePorts.has(fromPort) && activePorts.has(toPort);
    }

    return activePorts;
  }

  function isSimulationOn() {
    return project?.simulation !== false;
  }

  /* -------------------------- Project factories ------------------------ */

  function createRail(modules = []) {
    return { id: makeId('rail'), capacity: RAIL.capacity, modules };
  }

  function createEmptyProject(name = 'Новый щит') {
    return {
      id: makeId('prj'),
      name,
      rails: [createRail()],
      connections: [],
      source: { isOn: true },
      simulation: true,
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
      order: 0,
      color: libraryItem.color,
      ports: { top: libraryItem.ports.top, bottom: libraryItem.ports.bottom },
      isBusbar: libraryItem.isBusbar === true,
      busbarType: libraryItem.busbarType || null,
      tag: tag || generateTag(libraryItem.tagPrefix, project ? allModules() : []),
      isOn: true
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

    demo.rails[0].modules = demoItems.map(([libraryId, tag], index) => {
      const libraryItem = LIBRARY_BY_ID.get(libraryId);
      return {
        id: makeId('mod'),
        libraryId: libraryItem.id,
        type: libraryItem.type,
        name: libraryItem.name,
        width: libraryItem.width,
        order: index,
        color: libraryItem.color,
        ports: { top: libraryItem.ports.top, bottom: libraryItem.ports.bottom },
        tag,
        isOn: true
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
      color: WIRE_TYPES[type].color
    }));

    return demo;
  }

  function normalizeOrders() {
    project.rails.forEach((rail) => {
      rail.modules.forEach((module, index) => {
        module.order = index;
      });
    });
  }

  /* -------------------------- Project validation ----------------------- */

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

    function normalizeModules(rawModules) {
      const modules = [];
      let widthTotal = 0;

      for (const rawModule of rawModules) {
        if (!rawModule || typeof rawModule !== 'object') continue;

        const rawLibraryId = safeText(rawModule.libraryId, '', 40);
        const libraryItem = LIBRARY_BY_ID.get(rawLibraryId);
        const parsedWidth = Number(rawModule.width);
        const width = Number.isFinite(parsedWidth)
          ? clamp(Math.round(parsedWidth), 1, 6)
          : (libraryItem?.width || 1);

        if (widthTotal + width > capacity) break;

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
        const module = {
          id,
          libraryId,
          type,
          name,
          width,
          order: modules.length,
          color,
          ports,
          isBusbar: rawModule.isBusbar === true || libraryItem?.isBusbar === true,
          busbarType: rawModule.busbarType || libraryItem?.busbarType || null,
          tag,
          isOn: rawModule.isOn !== false
        };
        modules.push(module);
        normalizedModules.push(module);
        widthTotal += width;
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
          ? clamp(Math.round(parsedCapacity), 1, capacity)
          : capacity;
        rails.push({
          id,
          capacity: railCapacity,
          modules: normalizeModules(Array.isArray(rawRail?.modules) ? rawRail.modules : [])
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
        color: WIRE_TYPES[type].color
      });
    }

    return {
      id: safeId(raw.id) || makeId('prj'),
      name: safeText(raw.name, 'Новый щит', 60),
      rails,
      connections,
      source: { isOn: raw.source?.isOn !== false },
      simulation: raw.simulation !== false,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
    };
  }

  /* ----------------------------- Storage ------------------------------ */

  function setSaveState(state) {
    if (!dom.saveState) return;
    const isError = state === 'error';
    dom.saveState.classList.toggle('is-error', isError);
    dom.saveText.textContent = isError ? 'Не удалось сохранить' : 'Сохранено локально';
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

      if (needsWireMigration) showMigrationBanner = true;
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
      source: project.source || { isOn: true }
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
    project.source = restored.source || project.source || { isOn: true };

    resetInteractionState();
    clearConnectionDraft();
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
    return `
      <button class="component-card" type="button" data-library-id="${escapeHtml(item.id)}"
              style="--component-color:${item.color}"
              title="${escapeHtml(item.description)}"
              aria-label="${escapeHtml(`${item.name}, категория ${category?.label || '—'}, тег ${item.tagPrefix}, ширина ${moduleLabel}. ${item.description} Перетащите на рейку или нажмите, чтобы добавить.`)}">
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
    const channelWidth = 896;
    const scaleY = railY + RAIL.height + 12;
    const capacity = rail.capacity;
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

    const canDelete = rail.modules.length === 0 && project.rails.length > 1;
    const deleteButton = canDelete ? `
      <g class="rail-delete" data-delete-rail="${escapeHtml(rail.id)}"
         transform="translate(${RAIL.x + RAIL.width - 62} ${railY + 26})"
         tabindex="0" role="button" aria-label="${escapeHtml(`Удалить пустую рейку ${railIndex + 1}`)}">
        <circle class="rail-delete-hit" r="15"/>
        <circle class="rail-delete-bg" r="10"/>
        <path class="rail-delete-x" d="M -3.2 -3.2 L 3.2 3.2 M 3.2 -3.2 L -3.2 3.2"/>
      </g>` : '';

    return `
      <g class="rail${isDropTarget ? (overflow ? ' is-overflow' : ' is-drop-target') : ''}"
         data-rail-id="${escapeHtml(rail.id)}" data-rail-index="${railIndex}">
        <text class="rail-label" x="${RAIL.x + 4}" y="${railY - 9}">Рейка ${railIndex + 1}</text>
        <rect class="rail-plate" x="${RAIL.x}" y="${railY}" width="${RAIL.width}" height="${RAIL.height}"
              rx="18" filter="url(#rail-shadow)"/>
        <line class="rail-profile-highlight" x1="${RAIL.x + 19}" y1="${railY + 1.5}"
              x2="${RAIL.x + RAIL.width - 19}" y2="${railY + 1.5}"/>
        <line class="rail-profile-shadow" x1="${RAIL.x + 19}" y1="${railY + RAIL.height - 1.5}"
              x2="${RAIL.x + RAIL.width - 19}" y2="${railY + RAIL.height - 1.5}"/>
        <line class="rail-profile-side" x1="${RAIL.x + 1.4}" y1="${railY + 20}"
              x2="${RAIL.x + 1.4}" y2="${railY + RAIL.height - 20}"/>
        <line class="rail-profile-side" x1="${RAIL.x + RAIL.width - 1.4}" y1="${railY + 20}"
              x2="${RAIL.x + RAIL.width - 1.4}" y2="${railY + RAIL.height - 20}"/>
        <line class="rail-groove" x1="${RAIL.x + 24}" y1="${railY + 18}"
              x2="${RAIL.x + RAIL.width - 24}" y2="${railY + 18}"/>
        <line class="rail-groove-light" x1="${RAIL.x + 24}" y1="${railY + 17}"
              x2="${RAIL.x + RAIL.width - 24}" y2="${railY + 17}"/>
        <line class="rail-groove" x1="${RAIL.x + 24}" y1="${railY + RAIL.height - 18}"
              x2="${RAIL.x + RAIL.width - 24}" y2="${railY + RAIL.height - 18}"/>
        <line class="rail-groove-light" x1="${RAIL.x + 24}" y1="${railY + RAIL.height - 19}"
              x2="${RAIL.x + RAIL.width - 24}" y2="${railY + RAIL.height - 19}"/>
        <rect class="rail-perforation" x="${RAIL.x}" y="${railY}" width="${RAIL.width}" height="${channelTop - railY}"
              fill="url(#rail-holes)"/>
        <rect class="rail-perforation" x="${RAIL.x}" y="${channelBottom}" width="${RAIL.width}"
              height="${railY + RAIL.height - channelBottom}" fill="url(#rail-holes)"/>
        <rect class="rail-channel" x="${channelX}" y="${channelTop}" width="${channelWidth}" height="${channelBottom - channelTop}" rx="7"/>
        <line class="rail-metal-edge" x1="${channelX + 5}" y1="${channelTop + 2}" x2="${channelX + channelWidth - 5}" y2="${channelTop + 2}"/>
        <line class="rail-metal-edge" x1="${channelX + 5}" y1="${channelBottom - 2}" x2="${channelX + channelWidth - 5}" y2="${channelBottom - 2}"/>
        ${slotLines.join('')}
        ${screwMarkup(62, railY + 22)}
        ${screwMarkup(954, railY + 22)}
        ${screwMarkup(62, railY + RAIL.height - 22)}
        ${screwMarkup(954, railY + RAIL.height - 22)}
        <text class="rail-dimension" x="984" y="${railY + 133}" transform="rotate(90 984 ${railY + 133})">DIN 35 mm</text>
        <g class="rail-scale">
          <line class="rail-scale-base" x1="${RAIL.moduleX}" y1="${scaleY}" x2="${RAIL.moduleRight}" y2="${scaleY}"/>
          ${scaleTicks.join('')}
          ${scaleLabels.join('')}
        </g>
        ${overflow ? `<rect class="rail-overflow-outline" x="${channelX - 2}" y="${channelTop - 2}"
                            width="${channelWidth + 4}" height="${channelBottom - channelTop + 4}" rx="10"/>` : ''}
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
    const base = side === 'left' ? WIRE_CORRIDOR_X.left : WIRE_CORRIDOR_X.right;
    const shift = lane * CORRIDOR_LANE_GAP * (side === 'left' ? -1 : 1);
    return clamp(base + shift, 8, SVG_WIDTH - 8);
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

    const targetLane = reserve ? reserveLane(target.side, target.railIndex, span, laneUsage) : 0;
    const yTarget = laneY(target.side, targetLane, target.railIndex);
    const railCenter = (RAIL.moduleX + RAIL.moduleRight) / 2;
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

  function buildWireLayout(connection, positions, laneUsage, reserve = true) {
    const start = getPortPoint(connection.fromModuleId, connection.fromPortSide, connection.fromPortIndex, positions);
    const end = getPortPoint(connection.toModuleId, connection.toPortSide, connection.toPortIndex, positions);
    if (!start || !end) return null;

    if (start.moduleId === POWER_SOURCE.id || end.moduleId === POWER_SOURCE.id) {
      return buildSourceWireLayout(connection, start, end, laneUsage, reserve);
    }

    const sameRail = Boolean(start.railId) && start.railId === end.railId;
    const span = [Math.min(start.x, end.x), Math.max(start.x, end.x)];
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
      const railCenter = (RAIL.moduleX + RAIL.moduleRight) / 2;
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
    const laneUsage = { rails: {}, corridors: { left: [], right: [] }, source: [] };
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

  function buildWiresMarkup(layouts) {
    return layouts.map((layout) => {
      const connection = layout.connection;
      const typeKey = WIRE_TYPES[connection.type] ? connection.type : DEFAULT_WIRE_TYPE;
      const type = WIRE_TYPES[typeKey];
      const color = wireDisplayColor(typeKey);
      const isSelected = connection.id === selectedConnectionId;
      const flowClass = isSimulationOn()
        ? (connection.isLive ? ' is-live' : ' is-dead')
        : '';
      const label = connectionLabel(connection);
      const points = polylinePoints(layout.points);
      const badgeWidth = type.label.length > 1 ? 24 : 16;
      const badgeX = layout.badge.x;
      const badgeY = layout.badge.y;
      // У чёрного L2 на тёмном холсте нужен светлый контур, иначе линия теряется.
      const outline = typeKey === 'L2'
        ? `<polyline class="wire-outline" points="${points}"/>`
        : '';
      const deleteButton = isSelected ? `
        <g class="wire-delete" data-delete-wire="${escapeHtml(connection.id)}"
           transform="translate(${(badgeX + badgeWidth / 2 + 14).toFixed(1)} ${badgeY.toFixed(1)})"
           tabindex="0" role="button"
           aria-label="${escapeHtml(`Удалить провод ${label}`)}">
          <circle class="wire-delete-hit" r="13"/>
          <circle class="wire-delete-bg" r="9"/>
          <path class="wire-delete-x" d="M -3 -3 L 3 3 M 3 -3 L -3 3"/>
        </g>` : '';

      return `
        <g class="wire wire--${typeKey.toLowerCase()}${isSelected ? ' is-selected' : ''}${flowClass}"
           data-wire-id="${escapeHtml(connection.id)}"
           style="--wire-color:${color};color:${color}">
          <title>${escapeHtml(`${label}. ${type.name}. ${connection.isLive ? 'Под напряжением. ' : ''}Двойной клик удаляет провод.`)}</title>
          <polyline class="wire-halo" points="${points}" data-connection-id="${escapeHtml(connection.id)}"
                    tabindex="0" role="button"
                    aria-label="${escapeHtml(`${label}, ${type.name}. Enter — выделить, Delete — удалить.`)}"/>
          ${outline}
          <polyline class="wire-path" points="${points}"/>
          <g class="wire-badge" transform="translate(${badgeX.toFixed(1)} ${badgeY.toFixed(1)})" pointer-events="none">
            <rect x="${-badgeWidth / 2}" y="-9" width="${badgeWidth}" height="18" rx="9" fill="${color}"/>
            <text class="${tagTextClass(color)}" x="0" y="3.4">${type.label}</text>
          </g>
          ${deleteButton}
        </g>`;
    }).join('');
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
    const laneUsage = { rails: {}, corridors: { left: [], right: [] }, source: [] };
    const layout = buildWireLayout(draft, positions, laneUsage, false);
    if (!layout) return '';
    return `<polyline class="wire-preview" points="${polylinePoints(layout.points)}"/>`;
  }

  function buildSourceMarkup() {
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
      </g>`;
  }

  function buildSourcePortsMarkup(occupancy, phases) {
    const regular = [];
    let activeMarkup = '';
    const phaseMap = phases || new Map();

    POWER_SOURCE.ports.forEach((label, index) => {
      const point = sourcePortPoint(index);
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
      const markup = `
        <g class="${classes}" id="${portId}" data-port-id="${portId}" data-module-id="${POWER_SOURCE.id}"
           data-side="bottom" data-index="${index}" tabindex="0" role="button"
           ${phaseAttrs}
           aria-label="${escapeHtml(`Источник питания · ${label}.${phaseHint} ${hint}`)}">
          <circle class="port-hit" cx="${point.x.toFixed(1)}" cy="${point.y}" r="${PORT_HIT_RADIUS}"/>
          <circle class="port-halo" cx="${point.x.toFixed(1)}" cy="${point.y}" r="8"/>
          <circle class="port-dot" cx="${point.x.toFixed(1)}" cy="${point.y}" r="${PORT_RADIUS}"/>
        </g>`;
      if (isActive) activeMarkup = markup;
      else regular.push(markup);
    });

    return regular.join('') + activeMarkup;
  }

  function buildPortsMarkup(modules, positions, occupancy, phases) {
    const regular = [];
    let activeMarkup = '';
    const phaseMap = phases || new Map();

    for (const module of modules) {
      const position = positions.get(module.id);
      if (!position || module.__ghost) continue;
      const counts = portsForModule(module);
      const busType = isBusbarModule(module) ? busbarTypeOf(module) : null;
      const busLive = Boolean(busType) && isSimulationOn() && moduleHasLivePort(module, livePorts);

      for (const side of PORT_SIDES) {
        const y = side === 'top' ? position.y : position.y + MODULE_HEIGHT;
        for (let index = 0; index < counts[side]; index += 1) {
          const x = position.x + ((index + 1) * position.width) / (counts[side] + 1);
          const portId = makePortId(module.id, side, index);
          const portRef = { moduleId: module.id, side, index };
          const isActive = samePort(activePort, portRef);
          const isPending = samePort(pendingWire, portRef);
          const phase = phaseMap.get(portId) || null;
          const phaseName = phase ? WIRE_TYPES[phase].name : '';
          const classes = [
            'port',
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
          const markup = `
            <g class="${classes}" id="${portId}" data-port-id="${portId}" data-module-id="${escapeHtml(module.id)}"
               data-side="${side}" data-index="${index}" tabindex="0" role="button"
               ${phaseAttrs}
               aria-label="${escapeHtml(`${formatPortLabel(module, side, index)}.${phaseHint} ${hint}`)}">
              <circle class="port-hit" cx="${x.toFixed(1)}" cy="${y}" r="${PORT_HIT_RADIUS}"/>
              <circle class="port-halo" cx="${x.toFixed(1)}" cy="${y}" r="8"/>
              <circle class="port-dot" cx="${x.toFixed(1)}" cy="${y}" r="${PORT_RADIUS}"/>
            </g>`;
          // Активный порт рисуется последним — поверх остальных портов.
          if (isActive) activeMarkup = markup;
          else regular.push(markup);
        }
      }
    }
    return regular.join('') + activeMarkup;
  }

  function overlayAnchor(ref) {
    if (!ref) return null;
    const portId = makePortId(ref.moduleId, ref.side, ref.index);
    const element = dom.portLayer.querySelector(`[data-port-id="${portId}"] .port-dot`);
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

  // Шина — не обычный корпус автомата, а металлическая полоса с рядом
  // винтов-клемм сверху и снизу. Отрисовывается отдельно от стандартных
  // модулей, но сохраняет те же data-атрибуты, удаление и фокус.
  function buildBusbarModuleMarkup(module, x, y, options = {}) {
    const { isGhost = false, isInvalidGhost = false, isPending = false } = options;
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

    const screwMarkup = PORT_SIDES.map((side) => {
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
         aria-label="${escapeHtml(`${module.tag}: ${module.name}, ширина ${module.width} ${modulesWord}. Шина ${busType} с ${screwCount} клеммами сверху и снизу. Перетаскивание меняет порядок; порты создают провода только типа ${busType}.`)}"`;

    return `
      <g class="module module--busbar module--busbar-${typeClass}${isGhost ? ' module--ghost' : ''}${isInvalidGhost ? ' module--ghost-invalid' : ''}${isPending ? ' is-pending' : ''}${isLive ? ' is-bus-live' : ''}"
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
      </g>`;
  }

  function buildModuleMarkup(module, x, index, isInvalidGhost = false, y = RAIL.moduleY) {
    const width = module.width * MODULE_UNIT;
    const isGhost = Boolean(module.__ghost);
    const color = safeColor(module.color) || WIRE_COLORS[index % WIRE_COLORS.length];
    const isPending = !isGhost && (
      activePort?.moduleId === module.id || pendingWire?.moduleId === module.id
    );
    if (isBusbarModule(module)) {
      return buildBusbarModuleMarkup(module, x, y, { isGhost, isInvalidGhost, isPending });
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
         aria-label="${escapeHtml(`${module.tag}: ${module.name}, ширина ${module.width} ${modulesWord}.${switchable ? ` Сейчас ${isOn ? 'включён' : 'отключён'}.` : ''} Перетаскивание меняет порядок; порты сверху и снизу создают провода.`)}"`;

    return `
      <g class="module module--body-${bodyVariant}${isGhost ? ' module--ghost' : ''}${isInvalidGhost ? ' module--ghost-invalid' : ''}${isPending ? ' is-pending' : ''}"
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
        ${switchMarkup}
        ${circuit}
        <text class="module-rating" x="${panelCenterX.toFixed(1)}" y="${MODULE_HEIGHT - 42}">${escapeHtml(rating)}</text>
        <text class="module-brand" x="${panelCenterX.toFixed(1)}" y="${MODULE_HEIGHT - 32}">${escapeHtml(brand)}</text>
        <text class="module-name${verticalName ? ' is-vertical' : ''}${switchable && verticalName ? ' is-switch-vertical' : ''}"
              ${verticalName ? `transform="${nameTransform}"` : `x="${width / 2}" y="${nameY}"`}>${escapeHtml(nameText)}</text>
        <rect class="module-terminal-panel" x="1" y="${MODULE_HEIGHT - 30}" width="${width - 2}" height="29" rx="5"/>
        <line class="module-divider" x1="7" y1="${MODULE_HEIGHT - 25}" x2="${width - 7}" y2="${MODULE_HEIGHT - 25}"/>
        ${terminalMarkup}
        <text class="module-width" x="7" y="${MODULE_HEIGHT - 9}">${widthLabel}</text>
        ${deleteButton}
        <rect class="module-focus-ring" x="-4" y="-4" width="${width + 8}" height="${MODULE_HEIGHT + 8}"
              rx="13" fill="none" stroke="${color}"/>
        ${pendingBadge}
      </g>`;
  }

  function buildPreview() {
    const rails = project.rails.map((rail) => ({
      rail,
      modules: rail.modules.slice(),
      ghostId: null,
      overflow: false,
      required: usedWidth(rail),
      dropIndex: null
    }));
    const idle = () => ({ rails, ghostId: null, overRail: false, activeRailId: null, overflow: false, required: 0 });

    if (!dragState || !dragState.overRail) return idle();
    const targetRail = railById(dragState.targetRailId);
    if (!targetRail) return idle();

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
        order: -1,
        color: libraryItem.color,
        isOn: true,
        isBusbar: libraryItem.isBusbar === true,
        busbarType: libraryItem.busbarType || null,
        tag: dragState.ghostTag || generateTag(libraryItem.tagPrefix, allModules())
      };
    }

    for (const item of rails) {
      if (dragState.kind === 'reorder') {
        item.modules = item.modules.filter((module) => module.id !== dragState.moduleId);
      }
      if (item.rail.id === targetRail.id) {
        const index = clamp(dragState.dropIndex ?? item.modules.length, 0, item.modules.length);
        item.modules.splice(index, 0, ghost);
        item.dropIndex = index;
        item.ghostId = ghost.id;
      }
      item.required = sumWidths(item.modules);
      item.overflow = item.required > item.rail.capacity;
    }

    const active = rails.find((item) => item.rail.id === targetRail.id);
    return {
      rails,
      ghostId: ghost.id,
      overRail: true,
      activeRailId: targetRail.id,
      overflow: Boolean(active?.overflow),
      required: active?.required || 0,
      capacity: targetRail.capacity
    };
  }

  /* --------------------------- Zoom / Pan ----------------------------- */

  function baseCanvasSize() {
    return { width: SVG_WIDTH, height: canvasHeight() };
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
    const rect = dom.canvas.getBoundingClientRect();
    zoomAtClient(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function resetView() {
    viewState.x = 0;
    viewState.y = 0;
    viewState.zoom = 1;
    applyView();
  }

  function onCanvasWheel(event) {
    if (!project) return;
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
    const height = canvasHeight();
    if (dom.canvasSurface) dom.canvasSurface.setAttribute('height', String(height));
    if (dom.canvasGrid) dom.canvasGrid.setAttribute('height', String(height));
    applyView();
  }

  function renderCanvas() {
    const preview = buildPreview();
    const overRail = preview.overRail;
    const overflow = preview.overflow;

    dom.canvas.classList.toggle('is-overflow', overflow);
    dom.canvas.classList.toggle('is-drop-target', overRail && !overflow);
    dom.canvas.classList.toggle('is-connecting', Boolean(activePort));
    dom.canvasShell.classList.toggle('is-drop-target', overRail && !overflow);
    dom.canvasShell.classList.toggle('is-connecting', Boolean(activePort));
    updateCanvasSize();

    dom.railLayer.innerHTML = preview.rails
      .map((item, index) => buildRailMarkup(
        item.rail,
        index,
        item.overflow,
        overRail && item.rail.id === preview.activeRailId
      ))
      .join('');

    const positions = new Map();
    const previewModules = [];
    let globalIndex = 0;
    const moduleMarkup = preview.rails.map((item, railIndex) => {
      const moduleY = railModuleY(railIndex);
      let cursor = RAIL.moduleX;
      return item.modules.map((module) => {
        const width = module.width * MODULE_UNIT;
        positions.set(module.id, {
          x: cursor,
          center: cursor + width / 2,
          width,
          y: moduleY,
          railId: item.rail.id,
          railIndex,
          module
        });
        previewModules.push(module);
        const markup = buildModuleMarkup(
          module, cursor, globalIndex,
          Boolean(module.__ghost) && item.overflow, moduleY
        );
        globalIndex += 1;
        cursor += width;
        return markup;
      }).join('');
    }).join('');

    dom.moduleLayer.innerHTML = moduleMarkup;
    dom.sourceLayer.innerHTML = buildSourceMarkup();
    dom.wireLayer.innerHTML = buildWiresMarkup(buildWireLayouts(positions));
    const occupancy = getPortOccupancy();
    const phases = computePortPhases();
    dom.portLayer.innerHTML = buildPortsMarkup(previewModules, positions, occupancy, phases) +
      buildSourcePortsMarkup(occupancy, phases);
    dom.previewLayer.innerHTML = buildPreviewWire(positions);
    if (dom.portPhaseTooltip) dom.portPhaseTooltip.hidden = true;
    positionOverlays();

    const showAlert = overRail && overflow;
    dom.railAlert.hidden = !showAlert;
    if (showAlert) {
      const missing = Math.max(1, preview.required - preview.capacity);
      dom.railAlertText.textContent = `Не помещается: не хватает ${missing} P`;
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
      const key = module.libraryId || `name:${module.name}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          name: module.name,
          typeLabel: typeLabelFor(module),
          width: module.width,
          color: module.color,
          count: 0,
          tags: [],
          switchable: false,
          onCount: 0,
          offCount: 0
        });
      }
      const group = grouped.get(key);
      group.count += 1;
      if (module.tag) group.tags.push(module.tag);
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
          <td colspan="3" class="spec-empty">Пока пусто. Перетащите компонент из библиотеки на DIN-рейку.</td>
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
    dom.clearProject.disabled = !hasModules && project.connections.length === 0;
    if (dom.addRail) dom.addRail.disabled = project.rails.length >= MAX_RAILS;
    updateHistoryButtons();
  }

  function renderAll() {
    calculatePowerFlow();
    renderCanvas();
    renderSpecification();
    renderConnections();
    updateMetrics();
    updateLibraryAvailability();
    updateConnectionUI();
    updateActionState();
    updateDocumentTitle();
  }

  /* --------------------------- Drag & drop ---------------------------- */

  function svgPointFromEvent(event) {
    // Drag & drop работает в координатах схемы: обратная матрица CTM
    // пересчитывается для каждого события и учитывает текущий viewBox.
    return getSVGCoords(event);
  }

  // Координатный поиск порта: страховка для случаев, когда DOM-цель клика
  // перекрыта оверлеем или вложенным элементом. Позиции портов заданы в
  // координатах схемы, а точка указателя уже переведена через getSVGCoords —
  // поэтому совпадение работает при любом зуме и панорамировании.
  function portElementAtPoint(point) {
    if (!point) return null;
    let best = null;
    let bestDistance = Infinity;
    dom.portLayer.querySelectorAll('[data-port-id]').forEach((portElement) => {
      const dot = portElement.querySelector('.port-dot');
      if (!dot) return;
      const x = Number(dot.getAttribute('cx'));
      const y = Number(dot.getAttribute('cy'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= PORT_HIT_RADIUS && distance < bestDistance) {
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
          point.x <= RAIL.x + RAIL.width + 12 &&
          point.y >= railY - 40 &&
          point.y <= railY + RAIL.height + 40) {
        return index;
      }
    }
    return null;
  }

  function computeDropIndex(svgX, modules) {
    let cursor = RAIL.moduleX;
    let index = 0;
    for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
      const moduleWidth = modules[moduleIndex].width * MODULE_UNIT;
      if (svgX >= cursor + moduleWidth / 2) {
        index = moduleIndex + 1;
      } else {
        break;
      }
      cursor += moduleWidth;
    }
    return index;
  }

  function updateDragPosition(point) {
    if (!dragState) return;

    const railIndex = railIndexAtPoint(point);
    const overRail = railIndex !== null;
    let dropIndex = 0;
    let fits = false;
    let targetRailId = null;

    if (overRail) {
      const targetRail = project.rails[railIndex];
      targetRailId = targetRail.id;
      const remaining = targetRail.modules.filter((module) =>
        dragState.kind !== 'reorder' || module.id !== dragState.moduleId
      );
      dropIndex = computeDropIndex(point.x, remaining);
      fits = sumWidths(remaining) + dragState.width <= targetRail.capacity;
    }

    const changed = dragState.overRail !== overRail ||
      dragState.dropIndex !== dropIndex ||
      dragState.fits !== fits ||
      dragState.targetRailId !== targetRailId;

    dragState.overRail = overRail;
    dragState.dropIndex = dropIndex;
    dragState.fits = fits;
    dragState.targetRailId = targetRailId;

    if (changed) scheduleCanvasRender();
  }

  function resetInteractionState() {
    gesture = null;
    dragState = null;
    document.body.classList.remove('is-dragging');
  }

  function activateDrag(event) {
    if (!gesture) return;

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
        dropIndex: 0,
        fits: false
      };
    } else {
      const sourceModule = railOfModule(gesture.moduleId)?.module || null;
      if (!sourceModule) {
        resetInteractionState();
        return;
      }
      clearConnectionDraft();
      dragState = {
        kind: 'reorder',
        pointerId: event.pointerId,
        moduleId: sourceModule.id,
        width: sourceModule.width,
        overRail: false,
        targetRailId: null,
        dropIndex: sourceModule.order,
        fits: false
      };
    }

    document.body.classList.add('is-dragging');
  }

  function placeLibraryModule(libraryId, index, options = {}) {
    const libraryItem = LIBRARY_BY_ID.get(libraryId);
    if (!libraryItem) return false;

    const rail = railById(options.railId) || railWithRoom(libraryItem.width);
    if (!rail) return false;
    const free = rail.capacity - usedWidth(rail);
    if (libraryItem.width > free) {
      flashCanvasError();
      showToast(
        `Не помещается: нужно ${libraryItem.width} P, свободно ${free} P.`,
        'error',
        4000
      );
      return false;
    }

    const module = createModuleFromLibrary(libraryItem, options.tag);
    const insertionIndex = clamp(Number.isFinite(index) ? index : rail.modules.length, 0, rail.modules.length);
    rail.modules.splice(insertionIndex, 0, module);
    normalizeOrders();
    persistProject();
    commitHistory();
    renderAll();

    if (options.toast !== false) {
      showToast(`Добавлен ${libraryItem.name}`, 'success', 2200);
    }
    return true;
  }

  function moveModule(moduleId, targetRailId, targetIndex) {
    const source = railOfModule(moduleId);
    const targetRail = railById(targetRailId);
    if (!source || !targetRail) return false;

    const sourceRail = source.rail;
    const sourceIndex = sourceRail.modules.findIndex((module) => module.id === moduleId);
    if (sourceIndex < 0) return false;

    const before = project.rails.map((rail) => rail.modules.map((module) => module.id).join(',')).join('|');
    const [module] = sourceRail.modules.splice(sourceIndex, 1);
    const safeTarget = clamp(Number.isFinite(targetIndex) ? targetIndex : sourceIndex, 0, targetRail.modules.length);
    targetRail.modules.splice(safeTarget, 0, module);
    normalizeOrders();
    // Привязка проводов к рейке обновляется вместе с модулем.
    project.connections.forEach((connection) => {
      if (connection.fromModuleId === moduleId) connection.fromRailId = targetRail.id;
      if (connection.toModuleId === moduleId) connection.toRailId = targetRail.id;
    });
    const after = project.rails.map((rail) => rail.modules.map((item) => item.id).join(',')).join('|');

    if (before === after) {
      renderAll();
      return false;
    }

    persistProject();
    commitHistory();
    renderAll();
    return true;
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

    if (!finished.overRail || !finished.targetRailId) {
      renderAll();
      return;
    }

    const targetRail = railById(finished.targetRailId);
    if (!targetRail) {
      renderAll();
      return;
    }

    if (!finished.fits) {
      flashCanvasError();
      const free = targetRail.capacity - usedWidth(targetRail);
      showToast(`Не помещается на рейку: свободно ${free} P.`, 'error', 4000);
      renderAll();
      return;
    }

    if (finished.kind === 'library') {
      placeLibraryModule(finished.libraryId, finished.dropIndex, {
        railId: finished.targetRailId,
        tag: finished.ghostTag
      });
      return;
    }

    moveModule(finished.moduleId, finished.targetRailId, finished.dropIndex);
  }

  function cancelActiveInteraction() {
    if (!dragState && !gesture) return;
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
    if (rail) placeLibraryModule(libraryItem.id, rail.modules.length, { railId: rail.id });
  }

  function onCanvasPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (gesture || dragState) return;

    if (event.target.closest('[data-delete-module], [data-delete-wire], [data-delete-rail], [data-port-id], [data-connection-id], [data-toggle-module], [data-toggle-source]')) {
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

    gesture = {
      kind: 'reorder',
      moduleId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
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
    updateDragPosition(point);
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    if (dragState) {
      const point = svgPointFromEvent(event);
      if (point) updateDragPosition(point);
      finishDrag();
      return;
    }

    const finishedGesture = gesture;
    resetInteractionState();

    if (finishedGesture.kind === 'library') {
      const libraryItem = LIBRARY_BY_ID.get(finishedGesture.libraryId);
      const rail = libraryItem ? railWithRoom(libraryItem.width) : project.rails[0];
      if (rail) placeLibraryModule(finishedGesture.libraryId, rail.modules.length, { railId: rail.id });
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
      color: WIRE_TYPES[type].color
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
    selectedConnectionId = connectionId;
    renderAll();
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
    project.connections = project.connections.filter((connection) => {
      return connection.fromModuleId !== moduleId && connection.toModuleId !== moduleId;
    });
    if (activePort?.moduleId === moduleId || pendingWire?.moduleId === moduleId) {
      clearConnectionDraft();
    }
    selectedConnectionId = null;
    normalizeOrders();
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

    const nextSwitch = dom.sourceLayer?.querySelector('[data-toggle-source]');
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

  function onModuleToggleClick(event) {
    const toggle = event.target.closest?.('[data-toggle-module]');
    if (!toggle) return;
    // Клик по рычажку не должен запускать drag & drop или обработку холста.
    event.preventDefault();
    event.stopPropagation();
    toggleModule(toggle.getAttribute('data-toggle-module'));
  }

  function onModuleToggleKeyDown(event) {
    const toggle = event.target.closest?.('[data-toggle-module]');
    if (!toggle || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    toggleModule(toggle.getAttribute('data-toggle-module'));
  }

  function onCanvasClick(event) {
    if (performance.now() < suppressCanvasClickUntil) return;

    // Единая точка перевода курсора в координаты схемы для всех кликов по
    // холсту (порты, фон). getScreenCTM().inverse() учитывает текущий зум.
    const svgPoint = getSVGCoords(event);

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
      selectConnection(wire.getAttribute('data-connection-id'));
      return;
    }

    if (event.target.closest('[data-module-id]')) return;

    // Клик по пустому месту снимает выделение провода и отменяет выбор порта.
    selectedConnectionId = null;
    if (activePort || pendingWire) clearConnectionDraft();
    renderAll();
  }

  function onCanvasDblClick(event) {
    const wire = event.target.closest('[data-connection-id]');
    if (!wire) return;
    event.preventDefault();
    removeConnection(wire.getAttribute('data-connection-id'));
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

    const deleteRail = event.target.closest('[data-delete-rail]');
    if (deleteRail && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      removeRail(deleteRail.getAttribute('data-delete-rail'));
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
      if (!selectedConnectionId) return;
      if (event.target.matches?.('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      removeConnection(selectedConnectionId);
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
    if (allModules().length === 0 && project.connections.length === 0) return;

    project.rails = [createRail()];
    project.connections = [];
    project.source = { isOn: true };
    clearConnectionDraft();
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
      ['Название модуля', 'Тег', 'Количество', 'Статус'],
      ...specification.map((item) => [
        item.name,
        item.tags.join(', '),
        item.count,
        specificationStatusLabel(item)
      ])
    ];

    if (project.connections.length > 0) {
      rows.push([]);
      rows.push(['Соединения']);
      rows.push(['От', 'К', 'Тип']);
      for (const connection of project.connections) {
        rows.push([
          connectionPortLabel(connection, 'from'),
          connectionPortLabel(connection, 'to'),
          connection.type
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

    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `specification-${fileDate()}.csv`);

    showToast('Спецификация экспортирована в CSV', 'success', 2600);
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

  function exportCanvasSize() {
    // Экспорт всегда содержит всю схему, а не текущую область viewBox.
    return baseCanvasSize();
  }

  function stabilizeCanvasForExport() {
    if (!dragState && !gesture && !activePort && !pendingWire && !selectedConnectionId) return;

    resetInteractionState();
    clearConnectionDraft();
    selectedConnectionId = null;
    renderCanvas();
    updateConnectionUI();
  }

  function serializeCanvasForExport(width, height) {
    const source = dom.canvas;
    const clone = source.cloneNode(true);

    // Стили копируем до очистки клона: так индексы элементов ещё совпадают.
    inlineComputedStyles(source, clone);

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    // Сбрасываем масштаб/панораму: PNG должен показывать всю схему.
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // Убираем элементы интерфейса, которые не являются частью схемы:
    // превью провода, порты, кнопки удаления, хало и индикаторы выделения.
    clone.querySelectorAll([
      '#layer-preview',
      '#layer-ports',
      '#canvas-hit-area',
      '[data-delete-module]',
      '[data-delete-wire]',
      '[data-delete-rail]',
      '.wire-halo',
      '.module-focus-ring',
      '.module-pending-badge',
      '.rail-overflow-outline'
    ].join(', ')).forEach((element) => element.remove());

    return new XMLSerializer().serializeToString(clone);
  }

  function exportPng() {
    let markup;
    let width;
    let height;

    try {
      stabilizeCanvasForExport();
      ({ width, height } = exportCanvasSize());
      markup = serializeCanvasForExport(width, height);
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
        const imageWidth = Math.ceil(width + EXPORT_PADDING * 2);
        const imageHeight = Math.ceil(height + EXPORT_PADDING * 2);

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
        context.drawImage(image, EXPORT_PADDING, EXPORT_PADDING, width, height);

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
    dom.svgWrap.addEventListener('auxclick', (event) => {
      if (event.button === 1) event.preventDefault(); // без автопрокрутки браузера
    });
    if (dom.zoomInBtn) dom.zoomInBtn.addEventListener('click', () => zoomByStep(VIEW_ZOOM_STEP));
    if (dom.zoomOutBtn) dom.zoomOutBtn.addEventListener('click', () => zoomByStep(1 / VIEW_ZOOM_STEP));
    if (dom.resetViewBtn) dom.resetViewBtn.addEventListener('click', resetView);

    dom.canvas.addEventListener('pointerdown', onCanvasPointerDown);
    dom.canvas.addEventListener('click', onCanvasClick);
    dom.canvas.addEventListener('dblclick', onCanvasDblClick);
    dom.canvas.addEventListener('keydown', onCanvasKeyDown);
    // Слой модулей перехватывает клики/клавиши по рычажкам до обработчика холста.
    dom.moduleLayer.addEventListener('click', onModuleToggleClick);
    dom.moduleLayer.addEventListener('keydown', onModuleToggleKeyDown);

    dom.portLayer.addEventListener('pointerover', onPortPointerOver);
    dom.portLayer.addEventListener('pointerout', onPortPointerOut);

    dom.wireTypePopover.addEventListener('click', onWireTypeOptionClick);
    dom.wireTypeCancel.addEventListener('click', () => {
      if (!pendingWire) return;
      pendingWire = null; // первый порт остаётся активным
      renderAll();
    });
    document.addEventListener('pointerdown', onDocumentPointerDown);

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
    window.addEventListener('mouseup', onPanMouseUp);
    document.addEventListener('mouseleave', () => endPan());
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
    if (dom.addRail) dom.addRail.addEventListener('click', addRail);
    dom.undoBtn.addEventListener('click', undo);
    dom.redoBtn.addEventListener('click', redo);
    dom.exportCsv.addEventListener('click', exportCsv);
    dom.exportCsvSecondary.addEventListener('click', exportCsv);
    dom.exportPng.addEventListener('click', exportPng);
    dom.clearProject.addEventListener('click', openClearDialog);
    dom.clearDialog.addEventListener('close', onClearDialogClose);
  }

  /* ------------------------------- Init ------------------------------- */

  function init() {
    installVisualDefs();
    promoteWireLayer();
    renderLibrary();
    bindEvents();
    bootProject();
    resetHistory();

    dom.projectName.value = project.name;
    updateDocumentTitle();
    syncSimulationToggle();
    renderAll();

    // Баннер миграции показывается один раз: обновлённый проект уже записан в localStorage.
    const migrationText = dom.migrationBanner.querySelector('[data-migration-text]');
    if (migrationText) migrationText.textContent = MIGRATION_NOTICE;
    dom.migrationBanner.hidden = !showMigrationBanner;

    for (const [message, type] of bootNotices) {
      showToast(message, type, 5000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
