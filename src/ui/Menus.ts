import type { Difficulty, Format, PitchId, TeamSpec, TimeOfDay, WeatherId } from '../cricket/Types';
import { TEAMS } from '../cricket/Teams';

const CSS = `
.kmenu { position: fixed; inset: 0; display: flex; font-family: 'Segoe UI', system-ui, Arial, sans-serif; color: #fff;
  background: radial-gradient(ellipse at 50% 30%, rgba(10,30,20,0.88), rgba(2,6,10,0.96)); z-index: 10;
  overflow-y: auto; }
.kmenu .panel { text-align: center; max-width: 860px; width: 92%; margin: auto; padding: 24px 0; }
.kmenu h1 { font-size: 84px; margin: 0 0 4px; letter-spacing: 10px; font-weight: 900;
  background: linear-gradient(180deg,#fff,#7dd8a0); -webkit-background-clip: text; background-clip: text; color: transparent;
  text-shadow: 0 12px 44px rgba(60,220,140,0.25); }
.kmenu h2 { font-size: 20px; font-weight: 600; letter-spacing: 3px; color: #9fd8b4; margin: 0 0 28px; }
.kmenu .row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin: 14px 0; }
.kmenu .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
  padding: 14px 20px; cursor: pointer; min-width: 120px; transition: all .15s; pointer-events: auto; }
.kmenu .card:hover { background: rgba(255,255,255,0.12); transform: translateY(-2px); }
.kmenu .card.sel { background: rgba(60,220,140,0.18); border-color: #36d17c; box-shadow: 0 0 24px rgba(54,209,124,0.25); }
.kmenu .card .big { font-size: 26px; font-weight: 800; }
.kmenu .card .small { font-size: 12px; opacity: 0.75; margin-top: 4px; }
.kmenu .play { margin-top: 26px; display: inline-block; background: linear-gradient(180deg,#36d17c,#1d9e57); color: #04140b;
  font-size: 22px; font-weight: 900; letter-spacing: 2px; padding: 16px 66px; border-radius: 10px; cursor: pointer;
  pointer-events: auto; border: none; box-shadow: 0 8px 30px rgba(54,209,124,0.4); }
.kmenu .play:hover { filter: brightness(1.1); }
.kmenu .play:disabled { filter: grayscale(1); opacity: 0.5; cursor: default; }
.kmenu .section { font-size: 12px; letter-spacing: 2px; color: #7fa88e; margin-top: 20px; }
.kmenu .summary { background: rgba(255,255,255,0.05); border-radius: 10px; padding: 18px 26px; margin: 18px auto; max-width: 560px;
  font-size: 15px; line-height: 1.8; text-align: left; white-space: pre-line; }
.kmenu .teamdot { display:inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 7px; }
`;

export interface SetupChoices {
  format: Format;
  playerTeam: TeamSpec;
  opponent: TeamSpec;
  pitch: PitchId;
  weather: WeatherId;
  time: TimeOfDay;
  venueName: string;
  boundary: number;
  difficulty: Difficulty;
  spectate: boolean;
}

export class Menus {
  private overlay: HTMLDivElement | null = null;

  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  private show(html: string): HTMLDivElement {
    this.hide();
    this.overlay = document.createElement('div');
    this.overlay.className = 'kmenu';
    this.overlay.innerHTML = `<div class="panel">${html}</div>`;
    document.body.appendChild(this.overlay);
    return this.overlay;
  }

  hide(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  showTitle(onPlay: () => void, onWatch?: () => void): void {
    const el = this.show(`
      <h1>KRIKET</h1>
      <h2>A NEXT-GENERATION CRICKET SIMULATION</h2>
      <div class="row">
        <button class="play" id="kplay">PLAY</button>
        <button class="play" id="kwatch" style="background:linear-gradient(180deg,#4bafff,#2470c0);box-shadow:0 8px 30px rgba(75,175,255,0.35)">WATCH AI v AI</button>
      </div>
      <div class="row" style="margin-top:-4px">
        <button class="play" id="kmanual" style="background:transparent;border:1px solid rgba(255,255,255,0.35);box-shadow:none;font-size:14px;padding:10px 30px;letter-spacing:2px">📖 THE MANUAL</button>
      </div>
      <div class="section">FULL PHYSICS • SEAM • SWING • SPIN • WEAR • FIELDING • ALL THREE FORMATS</div>
    `);
    el.querySelector('#kplay')!.addEventListener('click', onPlay);
    if (onWatch) el.querySelector('#kwatch')!.addEventListener('click', onWatch);
    el.querySelector('#kmanual')!.addEventListener('click', () => window.open('/manual.html', '_blank'));
  }

  showSetup(onStart: (c: SetupChoices) => void, spectate = false): void {
    const formats: Format[] = ['T20', 'ODI', 'TEST'];
    const pitches: { id: PitchId; label: string }[] = [
      { id: 'flat_batting', label: 'Flat Deck' },
      { id: 'green_seamer', label: 'Green Seamer' },
      { id: 'dry_turner', label: 'Dry Turner' },
      { id: 'damp_english', label: 'Damp & Overcast' },
    ];
    const weathers: { id: WeatherId; label: string }[] = [
      { id: 'clear', label: 'Clear' },
      { id: 'overcast', label: 'Overcast (swing)' },
      { id: 'humid', label: 'Humid (heavy swing)' },
    ];
    const times: { id: TimeOfDay; label: string }[] = [
      { id: 'day', label: 'Day' },
      { id: 'twilight', label: 'Twilight' },
      { id: 'night', label: 'Night (lights)' },
    ];
    const difficulties: { id: Difficulty; label: string; sub: string }[] = [
      { id: 'rookie', label: 'Rookie', sub: 'generous timing' },
      { id: 'club', label: 'Club', sub: 'the intended game' },
      { id: 'pro', label: 'Pro', sub: 'punishing' },
    ];

    const state = {
      format: 'T20' as Format,
      playerTeam: TEAMS[0],
      opponent: TEAMS[2],
      pitch: 'flat_batting' as PitchId,
      weather: 'clear' as WeatherId,
      time: 'day' as TimeOfDay,
      difficulty: 'club' as Difficulty,
    };

    const el = this.show('<h1 style="font-size:46px">MATCH SETUP</h1><div id="body"></div>');
    const body = el.querySelector('#body')!;

    const render = (): void => {
      const teamCards = (sel: TeamSpec, key: 'playerTeam' | 'opponent'): string =>
        TEAMS.map(
          (t) =>
            `<div class="card ${sel.id === t.id ? 'sel' : ''}" data-k="${key}" data-v="${t.id}">
              <div class="big"><span class="teamdot" style="background:#${t.color.toString(16).padStart(6, '0')}"></span>${t.shortName}</div>
              <div class="small">${t.name}</div>
            </div>`,
        ).join('');
      body.innerHTML = `
        <div class="section">FORMAT</div>
        <div class="row">${formats
          .map((f) => `<div class="card ${state.format === f ? 'sel' : ''}" data-k="format" data-v="${f}"><div class="big">${f}</div><div class="small">${f === 'T20' ? '20 overs' : f === 'ODI' ? '50 overs' : '4 innings'}</div></div>`)
          .join('')}</div>
        <div class="section">${spectate ? 'TEAM A' : 'YOUR TEAM'}</div>
        <div class="row">${teamCards(state.playerTeam, 'playerTeam')}</div>
        <div class="section">${spectate ? 'TEAM B' : 'OPPONENT'}</div>
        <div class="row">${teamCards(state.opponent, 'opponent')}</div>
        ${spectate ? '' : `<div class="section">DIFFICULTY</div>
        <div class="row">${difficulties.map((d) => `<div class="card ${state.difficulty === d.id ? 'sel' : ''}" data-k="difficulty" data-v="${d.id}"><div class="big">${d.label}</div><div class="small">${d.sub}</div></div>`).join('')}</div>`}
        <div class="section">PITCH</div>
        <div class="row">${pitches.map((p) => `<div class="card ${state.pitch === p.id ? 'sel' : ''}" data-k="pitch" data-v="${p.id}">${p.label}</div>`).join('')}</div>
        <div class="section">CONDITIONS</div>
        <div class="row">${weathers.map((w) => `<div class="card ${state.weather === w.id ? 'sel' : ''}" data-k="weather" data-v="${w.id}">${w.label}</div>`).join('')}
        ${times.map((t) => `<div class="card ${state.time === t.id ? 'sel' : ''}" data-k="time" data-v="${t.id}">${t.label}</div>`).join('')}</div>
        <div class="row"><button class="play" id="kstart">${spectate ? 'START BROADCAST' : 'START MATCH'}</button></div>
      `;
      body.querySelectorAll('.card[data-k]').forEach((card) => {
        card.addEventListener('click', () => {
          const k = card.getAttribute('data-k')!;
          const v = card.getAttribute('data-v')!;
          if (k === 'format') state.format = v as Format;
          else if (k === 'playerTeam') state.playerTeam = TEAMS.find((t) => t.id === v)!;
          else if (k === 'opponent') state.opponent = TEAMS.find((t) => t.id === v)!;
          else if (k === 'pitch') state.pitch = v as PitchId;
          else if (k === 'weather') state.weather = v as WeatherId;
          else if (k === 'time') state.time = v as TimeOfDay;
          else if (k === 'difficulty') state.difficulty = v as Difficulty;
          render();
        });
      });
      body.querySelector('#kstart')!.addEventListener('click', () => {
        if (state.opponent.id === state.playerTeam.id) {
          state.opponent = TEAMS.find((t) => t.id !== state.playerTeam.id)!;
        }
        onStart({
          ...state,
          venueName: 'The Oval Ring',
          boundary: 64 + Math.round(Math.random() * 6),
          spectate,
        });
      });
    };
    render();
  }

  showToss(text: string, onDone: () => void): void {
    const el = this.show(`
      <h1 style="font-size:40px">THE TOSS</h1>
      <div class="summary" style="text-align:center">${text}</div>
      <div class="row"><button class="play" id="kgo">FIRST BALL</button></div>
    `);
    el.querySelector('#kgo')!.addEventListener('click', onDone);
  }

  showInningsBreak(summary: string, onDone: () => void): void {
    const el = this.show(`
      <h1 style="font-size:40px">INNINGS BREAK</h1>
      <div class="summary">${summary}</div>
      <div class="row"><button class="play" id="kgo2">RESUME</button></div>
    `);
    el.querySelector('#kgo2')!.addEventListener('click', onDone);
  }

  showResult(title: string, summary: string, onRestart: () => void): void {
    const el = this.show(`
      <h1 style="font-size:44px">${title}</h1>
      <div class="summary">${summary}</div>
      <div class="row"><button class="play" id="kagain">PLAY AGAIN</button></div>
    `);
    el.querySelector('#kagain')!.addEventListener('click', onRestart);
  }

  showPause(onResume: () => void, onQuit: () => void): void {
    const el = this.show(`
      <h1 style="font-size:40px">PAUSED</h1>
      <div class="row">
        <button class="play" id="kresume">RESUME</button>
        <button class="play" id="kquit" style="background:linear-gradient(180deg,#888,#555);box-shadow:none">QUIT TO TITLE</button>
      </div>
    `);
    el.querySelector('#kresume')!.addEventListener('click', onResume);
    el.querySelector('#kquit')!.addEventListener('click', onQuit);
  }
}
