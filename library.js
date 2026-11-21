/* =========================================================================
   library.js — БАЗА ЭЛЕМЕНТОВ конфигуратора «Щит.Студия»
   -------------------------------------------------------------------------
   Этот файл — единственный источник данных для левой панели библиотеки,
   спецификации и CSV-экспорта. Редактируйте только его, чтобы дополнить
   или изменить ассортимент: править script.js для добавления элемента
   больше не нужно.

   ВАЖНО: в index.html этот файл должен подключаться ПЕРЕД script.js:

       <script src="./library.js" defer></script>
       <script src="./script.js" defer></script>

   -------------------------------------------------------------------------
   КАК ДОБАВИТЬ СВОЙ ЭЛЕМЕНТ

   Скопируйте любой объект ниже, вставьте в массив и заполните поля:

     {
       id: "breaker-1p-c16",   // Уникальный id: латиница, цифры, - и _.
                               // Используется в localStorage, НЕ меняйте его
                               // у существующих элементов без крайней нужды.
       category: "Автоматы",   // Категория для группировки в UI.
                               // Категории создаются АВТОМАТИЧЕСКИ из этого
                               // поля — отдельный список категорий не нужен.
                               // Элементы с одинаковой категорией попадают
                               // в одну группу; порядок групп = порядок
                               // первого появления категории в массиве.
       name: "Автомат 1P C16", // Название в библиотеке и спецификации.
       type: "breaker",        // Тип: breaker, rcbo, rcd, contactor, relay,
                               // timer, impulse-relay, power-supply,
                               // voltmeter, meter, terminal, busbar.
                               // От типа зависят внешний вид и рычажок.
       typeLabel: "Автомат",   // Подпись типа в карточке и спецификации.
       width: 1,               // Ширина в модулях DIN (1P = 1, 3P = 3 ...).
       color: "#3b82f6",       // Акцентный цвет: 6 цифр в HEX.
       tagPrefix: "QF",        // Префикс авто-тега: 1–4 буквы (QF, QS, XT…).
       ports: {                // Количество клемм по граням корпуса.
         top: 1,               //   top / bottom — у обычных модулей,
         bottom: 1,            //   left / right — у боковых шин N/PE.
         left: 0,
         right: 0
       },
       isBusbar: false,        // true — только для шин N/PE.
       brand: "IEK",           // Бренд: попадает в спецификацию и CSV.
       sku: "MVA20-1-016",
       power: 1000,          // Только для type: "load" — мощность в Вт (по умолчанию 1000).     // Артикул: попадает в спецификацию и CSV.
       description: "..."      // Подсказка в карточке и поиск по библиотеке.
     }

   Для шин N/PE дополнительно укажите busType: "N" или "PE".
   После сохранения файла перезагрузите страницу — изменения появятся
   в левой панели, в спецификации и в экспорте CSV.
   ========================================================================= */

/* ВАЖНО: трёхфазный источник питания (порты L1, L2, L3, N, PE) НЕ является
   элементом библиотеки. Это закреплённый элемент интерфейса: он описан
   константой POWER_SOURCE в script.js и при запуске автоматически рисуется
   над первой DIN-рейкой в отдельной группе #layer-power-source. Его нельзя
   перетащить из левой панели, удалить или сохранить как модуль в JSON —
   поэтому НЕ добавляйте его сюда. Значение source.isOn в проекте хранит
   только состояние главного рубильника. */

window.ELECTRIC_LIBRARY = [
  /* ----------------------------- Автоматы ------------------------------ */
  {
    id: 'incoming-breaker-2p',
    category: 'Автоматы',
    name: 'Вводной автомат 2P C40',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 2,
    color: '#2563eb',
    tagPrefix: 'QF',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: 'S260S2C40',
    description: 'Главный ввод и защита двухполюсной линии 40 А, характеристика C.'
  },
  {
    id: 'breaker-1p-c16',
    category: 'Автоматы',
    name: 'Автомат 1P C16',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 1,
    color: '#3b82f6',
    tagPrefix: 'QF',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'MVA20-1-016',
    description: 'Однополюсная защитная линия 16 А, характеристика C.'
  },
  {
    id: 'breaker-1p-c25',
    category: 'Автоматы',
    name: 'Автомат 1P C25',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 1,
    color: '#0ea5e9',
    tagPrefix: 'QF',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'MVA20-1-025',
    description: 'Однополюсная линия 25 А для более мощной нагрузки.'
  },
  {
    id: 'breaker-3p',
    category: 'Автоматы',
    name: 'Автомат 3P C32',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 3,
    color: '#4f46e5',
    tagPrefix: 'QF',
    ports: { top: 3, bottom: 3, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Schneider Electric',
    sku: 'A9F74332',
    description: 'Трёхполюсная защита 32 А для силовой линии.'
  },

  /* ------------------------------- УЗО --------------------------------- */
  {
    id: 'rcd',
    category: 'УЗО',
    name: 'УЗО 2P 40A/30mA',
    type: 'rcd',
    typeLabel: 'УЗО',
    width: 2,
    color: '#0f766e',
    tagPrefix: 'QS',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'AD12-40-2-030',
    description: 'Двухполюсное УЗО для групповых линий, утечка 30 мА.'
  },
  {
    id: 'rcd-4p',
    category: 'УЗО',
    name: 'УЗО 4P 63A/30mA',
    type: 'rcd',
    typeLabel: 'УЗО',
    width: 4,
    color: '#059669',
    tagPrefix: 'QS',
    ports: { top: 4, bottom: 4, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Schneider Electric',
    sku: 'A9R52463',
    description: 'Четырёхполюсное УЗО для трёхфазной группы.'
  },
  {
    id: 'rcbo-1pn',
    category: 'УЗО',
    name: 'Дифавтомат 1P+N 16A/30mA',
    type: 'rcbo',
    typeLabel: 'Дифавтомат',
    width: 2,
    color: '#7c3aed',
    tagPrefix: 'QF',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: 'S260UC16K030',
    description: 'Автомат и УЗО в одном корпусе для влажных зон.'
  },

  /* ---------------------------- Коммутация ----------------------------- */
  {
    id: 'contactor',
    category: 'Коммутация',
    name: 'Контактор 2P 25A',
    type: 'contactor',
    typeLabel: 'Контактор',
    width: 2,
    color: '#9333ea',
    tagPrefix: 'KM',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Schneider Electric',
    sku: 'LC1K2510',
    description: 'Двухполюсный контактор управления нагрузкой.'
  },
  {
    id: 'voltage-relay',
    category: 'Коммутация',
    name: 'Реле напряжения 230V',
    type: 'relay',
    typeLabel: 'Реле',
    width: 1,
    color: '#dc2626',
    tagPrefix: 'KV',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ELECTRA',
    sku: 'RN-230',
    description: 'Защита оборудования от скачков напряжения.'
  },

  /* --------------------------- Автоматика ------------------------------ */
  {
    id: 'astro-timer',
    category: 'Автоматика',
    name: 'Астротаймер',
    type: 'timer',
    typeLabel: 'Таймер',
    width: 2,
    color: '#d97706',
    tagPrefix: 'KT',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'F&F',
    sku: 'ST-301',
    description: 'Включает освещение по астрономическому расписанию.'
  },
  {
    id: 'impulse-relay',
    category: 'Автоматика',
    name: 'Импульсное реле 16A',
    type: 'impulse-relay',
    typeLabel: 'Импульсное реле',
    width: 1,
    color: '#ea580c',
    tagPrefix: 'KV',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'FRL-16',
    description: 'Управление светом с нескольких кнопок.'
  },

  /* ------------------------ Клеммы и шины ------------------------------ */
  {
    id: 'terminal',
    category: 'Клеммы и шины',
    name: 'Клеммник 4 мм²',
    type: 'terminal',
    typeLabel: 'Клеммы',
    width: 2,
    color: '#4d7c0f',
    tagPrefix: 'XT',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'KLI-4',
    description: 'Проходные клеммы для проводников до 4 мм².'
  },
  {
    id: 'busbar-n',
    category: 'Клеммы и шины',
    name: 'Шина N (ноль) 6P',
    type: 'busbar',
    typeLabel: 'Шина N',
    width: 6,
    color: '#3b82f6',
    tagPrefix: 'XN',
    ports: { top: 6, bottom: 6, left: 0, right: 0 },
    isBusbar: true,
    busType: 'N',
    brand: 'IEK',
    sku: 'SHN-6',
    description: 'Медная шина нуля на 6 клемм: ток с любого порта растекается по всей шине. Подключаются только провода N.'
  },
  {
    id: 'busbar-pe',
    category: 'Клеммы и шины',
    name: 'Шина PE (земля) 6P',
    type: 'busbar',
    typeLabel: 'Шина PE',
    width: 6,
    color: '#65a30d',
    tagPrefix: 'XP',
    ports: { top: 6, bottom: 6, left: 0, right: 0 },
    isBusbar: true,
    busType: 'PE',
    brand: 'IEK',
    sku: 'SHPE-6',
    description: 'Серебристая шина заземления на 6 клемм: все порты становятся активными одновременно. Подключаются только провода PE.'
  },
  {
    id: 'busbar-n-left',
    category: 'Клеммы и шины',
    name: 'Шина N (левая) 1P',
    type: 'busbar',
    typeLabel: 'Шина N',
    width: 1,
    color: '#3b82f6',
    tagPrefix: 'XN',
    ports: { top: 0, bottom: 0, left: 10, right: 0 },
    isBusbar: true,
    busType: 'N',
    brand: 'IEK',
    sku: 'SHN-1L',
    description: 'Узкая медная шина нуля в корпусе 1P: 10 клемм по левой грани. Подключаются только провода N.'
  },
  {
    id: 'busbar-pe-right',
    category: 'Клеммы и шины',
    name: 'Шина PE (правая) 1P',
    type: 'busbar',
    typeLabel: 'Шина PE',
    width: 1,
    color: '#2563eb',
    tagPrefix: 'XP',
    ports: { top: 0, bottom: 0, left: 0, right: 10 },
    isBusbar: true,
    busType: 'PE',
    brand: 'IEK',
    sku: 'SHPE-1R',
    description: 'Узкая шина заземления в корпусе 1P: 10 клемм по правой грани. Подключаются только провода PE.'
  },

  /* ======================================================================
     НОВЫЕ ЭЛЕМЕНТЫ: популярные серии ведущих производителей
     (добавлены в конец массива — существующие позиции не изменены)
     ====================================================================== */

  /* -------------------------- ABB (S200 / DS201) ------------------------- */
  {
    id: 'abb-s201-c16',
    category: 'Автоматы',
    name: 'ABB S201 C16',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 1,
    color: '#dc2626',
    tagPrefix: 'QF',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: '2CDS251001R0164',
    price: 450,
    description: 'ABB S200, однополюсный автомат 16 А, характеристика C.'
  },
  {
    id: 'abb-s203-c32',
    category: 'Автоматы',
    name: 'ABB S203 C32',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 3,
    color: '#b91c1c',
    tagPrefix: 'QF',
    ports: { top: 3, bottom: 3, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: '2CDS253001R0324',
    price: 1150,
    description: 'ABB S200, трёхполюсный автомат 32 А, характеристика C.'
  },
  {
    id: 'abb-ds201-40-30ma',
    category: 'УЗО',
    name: 'ABB DS201 40A/30mA',
    type: 'rcd',
    typeLabel: 'УЗО',
    width: 2,
    color: '#991b1b',
    tagPrefix: 'QS',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: '2CSF202001R1400',
    price: 1500,
    description: 'ABB DS201, двухполюсное УЗО 40 А, ток утечки 30 мА.'
  },

  /* ------------------ Schneider Electric (Easy9 / Acti9) ---------------- */
  {
    id: 'schneider-easy9-c16',
    category: 'Автоматы',
    name: 'Schneider Electric Easy9 1P C16',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 1,
    color: '#16a34a',
    tagPrefix: 'QF',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Schneider Electric',
    sku: 'EZ9F56116',
    price: 350,
    description: 'Schneider Electric Easy9, однополюсный автомат 16 А, характеристика C.'
  },
  {
    id: 'schneider-easy9-3p-c32',
    category: 'Автоматы',
    name: 'Schneider Electric Easy9 3P C32',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 3,
    color: '#15803d',
    tagPrefix: 'QF',
    ports: { top: 3, bottom: 3, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Schneider Electric',
    sku: 'EZ9F56332',
    price: 980,
    description: 'Schneider Electric Easy9, трёхполюсный автомат 32 А, характеристика C.'
  },
  {
    id: 'schneider-easy9-rcd-40',
    category: 'УЗО',
    name: 'Schneider Electric Easy9 УЗО 2P 40A/30mA',
    type: 'rcd',
    typeLabel: 'УЗО',
    width: 2,
    color: '#166534',
    tagPrefix: 'QS',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Schneider Electric',
    sku: 'EZ9F56440',
    price: 1250,
    description: 'Schneider Electric Easy9, двухполюсное УЗО 40 А, ток утечки 30 мА.'
  },

  /* ------------------------- Legrand (DX3) ------------------------------- */
  {
    id: 'legrand-dx3-c16',
    category: 'Автоматы',
    name: 'Legrand DX3 1P C16',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 1,
    color: '#2563eb',
    tagPrefix: 'QF',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Legrand',
    sku: '4060111',
    price: 420,
    description: 'Legrand DX3, однополюсный автомат 16 А, характеристика C.'
  },
  {
    id: 'legrand-dx3-3p-c32',
    category: 'Автоматы',
    name: 'Legrand DX3 3P C32',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 3,
    color: '#1d4ed8',
    tagPrefix: 'QF',
    ports: { top: 3, bottom: 3, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Legrand',
    sku: '4060132',
    price: 1100,
    description: 'Legrand DX3, трёхполюсный автомат 32 А, характеристика C.'
  },
  {
    id: 'legrand-dx3-rcd-40',
    category: 'УЗО',
    name: 'Legrand DX3 УЗО 2P 40A/30mA',
    type: 'rcd',
    typeLabel: 'УЗО',
    width: 2,
    color: '#1e40af',
    tagPrefix: 'QS',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Legrand',
    sku: '4060770',
    price: 1400,
    description: 'Legrand DX3, двухполюсное УЗО 40 А, ток утечки 30 мА.'
  },

  /* ---------------------- IEK (BA47-29 / ВД1-63) ------------------------- */
  {
    id: 'iek-ba47-29-c16',
    category: 'Автоматы',
    name: 'IEK BA47-29 1P C16',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 1,
    color: '#ea580c',
    tagPrefix: 'QF',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'BA47-29-1-016',
    price: 250,
    description: 'IEK BA47-29, однополюсный автомат 16 А, характеристика C.'
  },
  {
    id: 'iek-ba47-29-c32',
    category: 'Автоматы',
    name: 'IEK BA47-29 3P C32',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 3,
    color: '#c2410c',
    tagPrefix: 'QF',
    ports: { top: 3, bottom: 3, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'BA47-29-3-032',
    price: 690,
    description: 'IEK BA47-29, трёхполюсный автомат 32 А, характеристика C.'
  },
  {
    id: 'iek-vd1-63-rcd-40',
    category: 'УЗО',
    name: 'IEK ВД1-63 УЗО 2P 40A/30mA',
    type: 'rcd',
    typeLabel: 'УЗО',
    width: 2,
    color: '#9a3412',
    tagPrefix: 'QS',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'VD1-63-2-40-030',
    price: 920,
    description: 'IEK ВД1-63, двухполюсное УЗО 40 А, ток утечки 30 мА.'
  },

  /* ------------------------ EKF (PROxima) -------------------------------- */
  {
    id: 'ekf-proxima-c16',
    category: 'Автоматы',
    name: 'EKF PROxima 1P C16',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 1,
    color: '#0891b2',
    tagPrefix: 'QF',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'EKF',
    sku: 'PRK-1-016',
    price: 220,
    description: 'EKF PROxima, однополюсный автомат 16 А, характеристика C.'
  },
  {
    id: 'ekf-proxima-c32',
    category: 'Автоматы',
    name: 'EKF PROxima 3P C32',
    type: 'breaker',
    typeLabel: 'Автомат',
    width: 3,
    color: '#0e7490',
    tagPrefix: 'QF',
    ports: { top: 3, bottom: 3, left: 0, right: 0 },
    isBusbar: false,
    brand: 'EKF',
    sku: 'PRK-3-032',
    price: 640,
    description: 'EKF PROxima, трёхполюсный автомат 32 А, характеристика C.'
  },
  {
    id: 'ekf-proxima-rcd-40',
    category: 'УЗО',
    name: 'EKF PROxima УЗО 2P 40A/30mA',
    type: 'rcd',
    typeLabel: 'УЗО',
    width: 2,
    color: '#155e75',
    tagPrefix: 'QS',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'EKF',
    sku: 'PRD-2-40-030',
    price: 870,
    description: 'EKF PROxima, двухполюсное УЗО 40 А, ток утечки 30 мА.'
  },

  /* ======================================================================
     КАСТОМНЫЕ ШИНЫ N/PE (собственное производство), добавлены в конец
     ====================================================================== */
  {
    id: 'busbar-n-left-1p',
    category: 'Шины',
    name: 'Шина N (левая)',
    type: 'busbar',
    typeLabel: 'Шина N',
    width: 1,
    color: '#3b82f6',
    tagPrefix: 'XN',
    ports: { top: 0, bottom: 0, left: 10, right: 0 },
    isBusbar: true,
    busType: 'N',
    brand: 'Собственное производство',
    price: 0,
    description: 'Кастомная шина нуля в корпусе 1P: 10 клемм по левой грани.'
  },
  {
    id: 'busbar-n-right-1p',
    category: 'Шины',
    name: 'Шина N (правая)',
    type: 'busbar',
    typeLabel: 'Шина N',
    width: 1,
    color: '#3b82f6',
    tagPrefix: 'XN',
    ports: { top: 0, bottom: 0, left: 0, right: 10 },
    isBusbar: true,
    busType: 'N',
    brand: 'Собственное производство',
    price: 0,
    description: 'Кастомная шина нуля в корпусе 1P: 10 клемм по правой грани.'
  },
  {
    id: 'busbar-pe-left-1p',
    category: 'Шины',
    name: 'Шина PE (левая)',
    type: 'busbar',
    typeLabel: 'Шина PE',
    width: 1,
    color: '#65a30d',
    tagPrefix: 'XP',
    ports: { top: 0, bottom: 0, left: 10, right: 0 },
    isBusbar: true,
    busType: 'PE',
    brand: 'Собственное производство',
    price: 0,
    description: 'Кастомная шина заземления в корпусе 1P: 10 клемм по левой грани.'
  },
  {
    id: 'busbar-pe-right-1p',
    category: 'Шины',
    name: 'Шина PE (правая)',
    type: 'busbar',
    typeLabel: 'Шина PE',
    width: 1,
    color: '#65a30d',
    tagPrefix: 'XP',
    ports: { top: 0, bottom: 0, left: 0, right: 10 },
    isBusbar: true,
    busType: 'PE',
    brand: 'Собственное производство',
    price: 0,
    description: 'Кастомная шина заземления в корпусе 1P: 10 клемм по правой грани.'
  },

  /* ======================================================================
     ДОПОЛНЕННАЯ БАЗА ЭЛЕМЕНТОВ: новые категории и позиции
     (добавлены в конец массива — существующие позиции не изменены)
     ====================================================================== */

  /* --------------------------- Дифавтоматы ------------------------------ */
  {
    id: 'rcbo-1pn-16',
    category: 'Дифавтоматы',
    name: 'Дифавтомат 1P+N 16A/30mA',
    type: 'rcbo',
    typeLabel: 'Дифавтомат',
    width: 2,
    color: '#7c3aed',
    tagPrefix: 'QF',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: '2CSR271016R1304',
    price: 1650,
    description: 'Дифавтомат 1P+N 16 А, ток утечки 30 мА, совмещает функции автомата и УЗО.'
  },
  {
    id: 'rcbo-1pn-32',
    category: 'Дифавтоматы',
    name: 'Дифавтомат 1P+N 32A/30mA',
    type: 'rcbo',
    typeLabel: 'Дифавтомат',
    width: 2,
    color: '#6d28d9',
    tagPrefix: 'QF',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: '2CSR271032R1304',
    price: 1790,
    description: 'Дифавтомат 1P+N 32 А, ток утечки 30 мА, для мощных групповых линий.'
  },

  /* ---------------------------- Контакторы ------------------------------ */
  {
    id: 'contactor-2p-25',
    category: 'Контакторы',
    name: 'Контактор 2P 25A',
    type: 'contactor',
    typeLabel: 'Контактор',
    width: 2,
    color: '#9333ea',
    tagPrefix: 'KM',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'LK1-25-10',
    price: 850,
    description: 'Двухполюсный контактор 25 А для дистанционного управления нагрузкой.'
  },
  {
    id: 'contactor-4p-40',
    category: 'Контакторы',
    name: 'Контактор 4P 40A',
    type: 'contactor',
    typeLabel: 'Контактор',
    width: 4,
    color: '#7e22ce',
    tagPrefix: 'KM',
    ports: { top: 4, bottom: 4, left: 0, right: 0 },
    isBusbar: false,
    brand: 'ABB',
    sku: 'VB7-40-40D-230',
    price: 2450,
    description: 'Четырёхполюсный контактор 40 А для управления трёхфазной нагрузкой.'
  },

  /* ------------------------- Реле и автоматика -------------------------- */
  {
    id: 'relay-voltage-1ph',
    category: 'Реле и автоматика',
    name: 'Реле напряжения однофазное',
    type: 'relay',
    typeLabel: 'Реле напряжения',
    width: 2,
    color: '#dc2626',
    tagPrefix: 'KV',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'EKF',
    sku: 'PRN-1-230',
    price: 950,
    description: 'Однофазное реле напряжения 230 В, защита оборудования от просадок и перенапряжения.'
  },
  {
    id: 'relay-voltage-3ph',
    category: 'Реле и автоматика',
    name: 'Реле напряжения трехфазное',
    type: 'relay',
    typeLabel: 'Реле напряжения',
    width: 3,
    color: '#b91c1c',
    tagPrefix: 'KV',
    ports: { top: 3, bottom: 3, left: 0, right: 0 },
    isBusbar: false,
    brand: 'EKF',
    sku: 'PRN-3-400',
    price: 1850,
    description: 'Трёхфазное реле напряжения 400 В, контроль фаз и защита двигателей.'
  },
  {
    id: 'relay-astro-timer',
    category: 'Реле и автоматика',
    name: 'Таймер астрономический',
    type: 'relay',
    typeLabel: 'Таймер',
    width: 2,
    color: '#d97706',
    tagPrefix: 'KT',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'TIM-AST-220',
    price: 1250,
    description: 'Астрономический таймер включает освещение по времени заката и рассвета.'
  },
  {
    id: 'relay-power-supply-24v',
    category: 'Реле и автоматика',
    name: 'Блок питания 24V',
    type: 'relay',
    typeLabel: 'Блок питания',
    width: 2,
    color: '#ca8a04',
    tagPrefix: 'KV',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'BP-24-60',
    price: 1550,
    description: 'DIN-блок питания 24 В постоянного тока для цепей автоматики и реле.'
  },

  /* ----------------------- Измерительные приборы ------------------------ */
  {
    id: 'meter-1ph',
    category: 'Измерительные приборы',
    name: 'Счетчик однофазный',
    type: 'meter',
    typeLabel: 'Счётчик',
    width: 3,
    color: '#0891b2',
    tagPrefix: 'PI',
    ports: { top: 2, bottom: 2, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'MTR-1-230',
    price: 2100,
    description: 'Однофазный счётчик активной энергии 230 В для учёта потребления.'
  },
  {
    id: 'meter-voltmeter-din',
    category: 'Измерительные приборы',
    name: 'Вольтметр на DIN-рейку',
    type: 'meter',
    typeLabel: 'Вольтметр',
    width: 1,
    color: '#0284c7',
    tagPrefix: 'PV',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'EKF',
    sku: 'PRV-230',
    price: 680,
    description: 'Вольтметр на DIN-рейку для контроля напряжения в сети 230 В.'
  },

  /* ----------------------------- Клеммники ------------------------------ */
  {
    id: 'terminal-2-5mm2',
    category: 'Клеммники',
    name: 'Клеммник проходной 2.5 мм²',
    type: 'terminal',
    typeLabel: 'Клеммник',
    width: 1,
    color: '#4d7c0f',
    tagPrefix: 'XT',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'KLI-2.5',
    price: 45,
    description: 'Проходной клеммник на 2.5 мм² для соединения проводников.'
  },
  {
    id: 'terminal-6mm2',
    category: 'Клеммники',
    name: 'Клеммник проходной 6 мм²',
    type: 'terminal',
    typeLabel: 'Клеммник',
    width: 1,
    color: '#3f6212',
    tagPrefix: 'XT',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'IEK',
    sku: 'KLI-6',
    price: 75,
    description: 'Проходной клеммник на 6 мм² для силовых проводников.'
  },

  /* ------------------------------ Нагрузка ----------------------------- */
  {
    id: 'load-1ph',
    category: 'Нагрузка',
    name: 'Нагрузка 1Ф 230В',
    type: 'load',
    typeLabel: 'Нагрузка',
    width: 1,
    color: '#f59e0b',
    tagPrefix: 'EL',
    ports: { top: 1, bottom: 1, left: 0, right: 0 },
    isBusbar: false,
    brand: 'Потребитель',
    sku: 'LOAD-1P',
    // Мощность потребителя в ваттах (по умолчанию 1000 Вт).
    // Редактируется двойным кликом по модулю на холсте.
    power: 1000,
    description: 'Однофазная нагрузка 230 В. Ток рассчитывается как I = P / 230. Двойной клик по модулю задаёт мощность в ваттах.'
  }
];
