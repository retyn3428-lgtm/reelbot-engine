import { useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Cloud,
  FileVideo,
  FolderOpen,
  Gauge,
  Layers3,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  Play,
  Plus,
  Scissors,
  Sparkles,
  Subtitles,
  Upload,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";

const captionStyles = [
  { id: "glass-pulse", name: "Glass Pulse", note: "стекло · акцентные слова", color: "#d5ff50" },
  { id: "editorial", name: "Editorial", note: "капс · мягкая тень", color: "#ff8f72" },
  { id: "clean-pop", name: "Clean Pop", note: "без плашки · pop-up", color: "#bda8ff" },
  { id: "soft-label", name: "Soft Label", note: "круглая плашка · фразы", color: "#78d9ff" },
];

const zoomStyles = [
  { id: "punch", name: "Punch-in", note: "резкий акцент" },
  { id: "drift", name: "Drift", note: "плавный наезд" },
  { id: "snap", name: "Snap back", note: "наезд + возврат" },
  { id: "word", name: "Word zoom", note: "по ключевому слову" },
];

const presets = [
  { title: "Экспертный Reels", tag: "glass + pink", detail: "Glass Pulse / Punch-in / 9:16", accent: "lime" },
  { title: "Тёплый сторителлинг", tag: "soft editorial", detail: "Editorial / Drift / Warm grade", accent: "coral" },
  { title: "Быстрый хук", tag: "high retention", detail: "Clean Pop / Word zoom / captions", accent: "violet" },
];

type FileItem = { name: string; size: string; type: "reference" | "source" };

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  const [activeSection, setActiveSection] = useState("Проекты");
  const [uploadMode, setUploadMode] = useState<"reference" | "source">("reference");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedCaption, setSelectedCaption] = useState("glass-pulse");
  const [selectedZoom, setSelectedZoom] = useState("punch");
  const [position, setPosition] = useState("Грудь");
  const [opacity, setOpacity] = useState(50);
  const [duration, setDuration] = useState("до 60 сек");
  const [queued, setQueued] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentCaption = useMemo(() => captionStyles.find((style) => style.id === selectedCaption) ?? captionStyles[0], [selectedCaption]);
  const currentZoom = useMemo(() => zoomStyles.find((style) => style.id === selectedZoom) ?? zoomStyles[0], [selectedZoom]);

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const incoming = Array.from(fileList).map((file) => ({
      name: file.name,
      size: formatBytes(file.size),
      type: uploadMode,
    }));
    setFiles((previous) => [...previous, ...incoming]);
  }

  function openPicker(mode: "reference" | "source") {
    setUploadMode(mode);
    window.setTimeout(() => inputRef.current?.click(), 0);
  }

  function removeFile(index: number) {
    setFiles((previous) => previous.filter((_, fileIndex) => fileIndex !== index));
  }

  return (
    <div className="reel-app-shell">
      <aside className="side-rail">
        <div className="brand-lockup"><span className="brand-mark">R/</span><span className="brand-name">REELBOT</span></div>
        <div className="rail-label">WORKSPACE</div>
        <nav className="rail-nav" aria-label="Основная навигация">
          {[{ name: "Проекты", icon: Layers3 }, { name: "Референсы", icon: Play }, { name: "Пресеты", icon: Sparkles }, { name: "Очередь", icon: Clock3 }].map(({ name, icon: Icon }) => (
            <button key={name} className={`rail-item ${activeSection === name ? "is-active" : ""}`} onClick={() => setActiveSection(name)}>
              <Icon size={17} strokeWidth={1.8} /><span>{name}</span>{name === "Очередь" && <span className="rail-count">2</span>}
            </button>
          ))}
        </nav>
        <div className="rail-spacer" />
        <div className="cloud-status"><span className="status-dot" /><div><span>ОБЛАКО ГОТОВО</span><small>данные синхронизированы</small></div></div>
        <button className="rail-profile"><span className="profile-avatar">А</span><span><b>Анастасия</b><small>личный workspace</small></span><MoreHorizontal size={17} /></button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Открыть меню"><Menu size={19} /></button>
          <div className="breadcrumbs"><span>WORKSPACE</span><b>/</b><strong>{activeSection.toUpperCase()}</strong></div>
          <div className="topbar-actions"><span className="sync-label"><Cloud size={15} /> auto-save on</span><button className="icon-button" aria-label="Уведомления"><MessageSquareText size={17} /></button><button className="avatar-small">А</button></div>
        </header>

        <section className="hero-row">
          <div><div className="eyebrow"><span className="eyebrow-line" />AUTOMATED VIDEO WORKSPACE</div><h1>Собери ролик<br /><em>из сырых дублей.</em></h1><p className="hero-copy">Загрузи референс, добавь съёмку — ReelBot соберёт монтаж, который можно сразу проверить.</p></div>
          <div className="hero-actions"><button className="secondary-action" onClick={() => openPicker("reference")}><FolderOpen size={16} /> Открыть проект</button><button className="primary-action" onClick={() => openPicker("source")}><Plus size={17} /> Новый монтаж <ArrowUpRight size={16} /></button></div>
        </section>

        <section className="workflow-strip" aria-label="Сценарий монтажа">
          {[{ no: "01", title: "РЕФЕРЕНС", desc: "покажи стиль" }, { no: "02", title: "ИСХОДНИКИ", desc: "добавь дубли" }, { no: "03", title: "СТИЛЬ", desc: "выбери приёмы" }, { no: "04", title: "РЕЗУЛЬТАТ", desc: "получи ролик" }].map((step, index) => <div className={`flow-step ${index === 0 ? "is-current" : ""}`} key={step.no}><span>{step.no}</span><div><b>{step.title}</b><small>{step.desc}</small></div>{index < 3 && <div className="flow-arrow">→</div>}</div>)}
        </section>

        <div className="content-grid">
          <section className="left-column">
            <div className="section-heading"><div><span className="section-kicker">01 / MATERIALS</span><h2>Материалы проекта</h2></div><button className="tiny-link" onClick={() => setFiles([])}>очистить <X size={12} /></button></div>
            <div className="material-card">
              <div className="material-tabs"><button className={uploadMode === "reference" ? "is-selected" : ""} onClick={() => setUploadMode("reference")}><Sparkles size={15} />Референс стиля <span className="tab-badge">optional</span></button><button className={uploadMode === "source" ? "is-selected" : ""} onClick={() => setUploadMode("source")}><FileVideo size={15} />Исходные дубли <span className="tab-badge">required</span></button></div>
              <div className={`dropzone ${uploadMode === "source" ? "dropzone-source" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
                <input ref={inputRef} hidden type="file" accept="video/*" multiple onChange={(event) => addFiles(event.target.files)} />
                <div className="drop-icon"><Upload size={20} /></div><div><b>{uploadMode === "reference" ? "Перетащи видео-референс сюда" : "Перетащи исходные видео сюда"}</b><p>или нажми, чтобы выбрать · mp4, mov, webm</p></div><span className="drop-cta">CHOOSE FILES</span>
              </div>
              {files.length > 0 && <div className="file-list">{files.map((file, index) => <div className="file-row" key={`${file.name}-${index}`}><div className={`file-type ${file.type}`}><FileVideo size={14} /></div><div className="file-meta"><b>{file.name}</b><small>{file.type === "reference" ? "референс стиля" : "исходный дубль"} · {file.size}</small></div><button onClick={() => removeFile(index)} aria-label={`Удалить ${file.name}`}><X size={15} /></button></div>)}</div>}
              <div className="source-footer"><span><Cloud size={14} /> после обработки сохраним в OneDrive</span><button className="connect-link">подключить Dropbox <ArrowUpRight size={13} /></button></div>
            </div>

            <div className="section-heading style-heading"><div><span className="section-kicker">02 / STYLE LAB</span><h2>Монтажный рецепт</h2></div><span className="recipe-status"><span className="status-dot" /> draft preset</span></div>
            <div className="style-card">
              <div className="control-row"><div><span className="control-label">Субтитры</span><b>{currentCaption.name}</b></div><div className="style-swatch" style={{ background: currentCaption.color }} /><div className="control-options">{captionStyles.map((style) => <button key={style.id} className={selectedCaption === style.id ? "option-active" : ""} title={style.note} onClick={() => setSelectedCaption(style.id)}>{style.name}</button>)}</div></div>
              <div className="control-divider" />
              <div className="control-row"><div><span className="control-label">Плашка</span><b>матовое стекло</b></div><div className="glass-mini" style={{ opacity: opacity / 100 }} /><div className="slider-block"><input aria-label="Прозрачность стекла" type="range" min="20" max="80" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /><span>{opacity}%</span></div></div>
              <div className="control-divider" />
              <div className="control-row"><div><span className="control-label">Зум</span><b>{currentZoom.name}</b></div><Zap size={16} className="control-icon" /><div className="control-options">{zoomStyles.map((zoom) => <button key={zoom.id} className={selectedZoom === zoom.id ? "option-active" : ""} title={zoom.note} onClick={() => setSelectedZoom(zoom.id)}>{zoom.name}</button>)}</div></div>
              <div className="control-divider" />
              <div className="control-row compact-row"><div><span className="control-label">Расположение слов</span><b>{position}</b></div><div className="segmented">{["Сверху", "Грудь", "Снизу"].map((item) => <button key={item} className={position === item ? "is-on" : ""} onClick={() => setPosition(item)}>{item}</button>)}</div></div>
              <div className="style-bottom"><button className="save-preset"><Sparkles size={14} /> Сохранить как пресет</button><label className="duration-select">{duration}<ChevronDown size={14} /><select value={duration} onChange={(event) => setDuration(event.target.value)} aria-label="Длительность ролика"><option>до 30 сек</option><option>до 60 сек</option><option>до 3 мин</option><option>до 5 мин</option></select></label></div>
            </div>

            <div className="queue-heading"><div><span className="section-kicker">03 / RENDER QUEUE</span><h2>Последние проекты</h2></div><button className="tiny-link">вся очередь <ArrowUpRight size={12} /></button></div>
            <div className="queue-list"><div className="queue-item"><div className="queue-thumb thumb-one"><span>HOOK<br />LAB</span><Play size={13} /></div><div className="queue-info"><b>Почему ролики не заходят</b><small>Экспертный Reels · 00:42</small></div><span className="queue-state ready"><Check size={13} /> готово</span><button className="more-btn"><MoreHorizontal size={16} /></button></div><div className="queue-item"><div className="queue-thumb thumb-two"><span>NEW<br />CUT</span><Play size={13} /></div><div className="queue-info"><b>Монтаж из сырых дублей</b><small>анализируем исходники · 68%</small></div><span className="queue-state processing"><span className="mini-loader" /> анализ</span><button className="more-btn"><MoreHorizontal size={16} /></button></div></div>
          </section>

          <aside className="right-column">
            <div className="preview-heading"><div><span className="section-kicker">LIVE PREVIEW</span><h2>Так будет выглядеть</h2></div><span className="format-pill">9:16</span></div>
            <div className="phone-stage"><div className="phone-frame"><div className="phone-top"><span>9:41</span><span>•••</span></div><div className="phone-video"><div className="video-grain" /><div className="preview-person"><div className="person-head" /><div className="person-body" /></div><div className={`preview-caption caption-${selectedCaption}`}><span>Сделай так,</span><strong>чтобы досмотрели</strong><i>до конца</i></div><div className="preview-label">{currentZoom.name.toUpperCase()} · {position.toUpperCase()}</div><div className="play-overlay"><Play size={17} fill="currentColor" /></div></div><div className="phone-bottom"><span>reelbot / draft 01</span><span>•••</span></div></div></div>
            <div className="preview-meta"><div><span>STYLE</span><b>{currentCaption.name}</b></div><div><span>MOTION</span><b>{currentZoom.name}</b></div><div><span>GLASS</span><b>{opacity}%</b></div></div>
            <button className={`render-button ${queued ? "is-queued" : ""}`} onClick={() => setQueued(true)}>{queued ? <><Check size={17} /> добавлено в очередь</> : <><WandSparkles size={17} /> Запустить монтаж <ArrowUpRight size={16} /></>}</button>
            <p className="render-note"><Gauge size={13} /> сначала соберём превью, потом полный ролик</p>
            <div className="preset-panel"><div className="preset-panel-head"><div><span className="section-kicker">SAVED RECIPES</span><h3>Твои пресеты</h3></div><button aria-label="Добавить пресет"><Plus size={16} /></button></div>{presets.map((preset) => <button className="preset-row" key={preset.title} onClick={() => { setSelectedCaption(preset.accent === "lime" ? "glass-pulse" : preset.accent === "coral" ? "editorial" : "clean-pop"); setSelectedZoom(preset.accent === "lime" ? "punch" : preset.accent === "coral" ? "drift" : "word"); }}><span className={`preset-dot ${preset.accent}`} /><span><b>{preset.title}</b><small>{preset.detail}</small></span><ArrowUpRight size={14} /></button>)}</div>
          </aside>
        </div>
      </main>
    </div>
  );
}
