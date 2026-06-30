import { ZapboxController } from './ZapboxController.js';
import { ZAPBOX_WORDMARK_SVG } from './branding.js';
import type { ControllerManagerOptions, ControllerUpdate } from './types.js';

type Side = 'left' | 'right';

/** Sentinel returned by a pairing step when the user opts to finish with the controllers they have. */
const STOP = Symbol('stop');

/** Duration of the setup bottom-sheet slide-in / slide-out transition, in ms. */
const UI_SLIDE_MS = 300;

interface ButtonDef {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export class ZapboxControllerManager {
  private _left: ZapboxController | null = null;
  private _right: ZapboxController | null = null;
  private _ui: HTMLDivElement | null = null;
  private _headingEl: HTMLDivElement | null = null;
  private _bodyEl: HTMLParagraphElement | null = null;
  private _buttonsRow: HTMLDivElement | null = null;

  private readonly _min: number;
  private readonly _max: number;
  private readonly _recommended: number | undefined;

  constructor(private readonly options: ControllerManagerOptions) {
    // Clamp to the 2-controller hardware ceiling and keep min ≤ max.
    const max = Math.min(2, Math.max(0, Math.round(options.max ?? 2)));
    const min = Math.min(max, Math.max(0, Math.round(options.min ?? 0)));
    this._min = min;
    this._max = max;
    const rec = options.recommended;
    this._recommended = rec !== undefined && rec >= min && rec <= max ? Math.round(rec) : undefined;
  }

  get left(): ZapboxController | null { return this._left; }
  get right(): ZapboxController | null { return this._right; }

  /** Runs the guided pairing flow. Returns the number of controllers actually connected. */
  async setup(): Promise<number> {
    this._left?.disconnect();
    this._right?.disconnect();
    this._left = null;
    this._right = null;

    this._ui = this._createUI();
    document.body.appendChild(this._ui);
    // Slide up from the bottom: force a reflow so the initial translateY(100%) is committed before
    // we transition to 0, otherwise the browser collapses both into a single no-op style change.
    void this._ui.offsetHeight;
    this._ui.style.transform = 'translateY(0)';

    // How many controllers? Skip the question when the range is fixed (min === max).
    const targetCount = this._min === this._max
      ? this._min
      : await this._chooseCountStep();

    let firstSide: Side | undefined;
    let connected = 0;
    for (let i = 0; i < targetCount; i++) {
      const forcedSide = i > 0 && firstSide !== undefined
        ? (firstSide === 'left' ? 'right' : 'left') as Side
        : undefined;
      // Once min is satisfied, let the user finish early — including with zero controllers when
      // min is 0 (they may have picked a higher count but changed their mind at the first prompt).
      const canStop = connected >= this._min;
      const result = await this._pairOne(i + 1, targetCount, forcedSide, canStop);
      if (result === STOP) break;
      if (i === 0) firstSide = result;
      connected++;
    }

    await this._teardownUI();
    return connected;
  }

  private async _teardownUI(): Promise<void> {
    const ui = this._ui;
    this._ui = null;
    this._headingEl = null;
    this._bodyEl = null;
    this._buttonsRow = null;
    if (!ui) return;
    // Slide back down, then remove once the transition finishes.
    ui.style.transform = 'translateY(100%)';
    await new Promise<void>(resolve => setTimeout(resolve, UI_SLIDE_MS));
    ui.remove();
  }

  private _chooseCountStep(): Promise<number> {
    return new Promise(resolve => {
      const buttons: ButtonDef[] = [];
      for (let n = this._min; n <= this._max; n++) {
        const label = n === 0
          ? 'Continue without controllers'
          : `${n} controller${n === 1 ? '' : 's'}`;
        buttons.push({ label, primary: n === this._recommended, onClick: () => resolve(n) });
      }
      let body = 'How many Zapbox controllers would you like to connect?';
      if (this._recommended !== undefined) {
        body += this._recommended === 0
          ? ' This page recommends continuing without controllers for this experience.'
          : ` This page recommends using ${this._recommended} controller${this._recommended === 1 ? '' : 's'} for this experience.`;
      }
      this._setContent('Controller setup', body, buttons);
    });
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this._left?.disconnect(),
      this._right?.disconnect(),
    ]);
  }

  async reconnect(): Promise<void> {
    await Promise.all([
      this._left?.reconnect(),
      this._right?.reconnect(),
    ]);
  }

  private async _pairOne(
    index: number,
    total: number,
    forcedSide?: Side,
    canStop = false,
  ): Promise<Side | typeof STOP> {
    const side = forcedSide ?? await this._chooseSideStep(index, total);
    const sideLabel = side === 'left' ? 'Left' : 'Right';

    while (true) {
      const controller = await this._connectStep(sideLabel, index, total, canStop);
      if (controller === STOP) return STOP;
      if (controller === null) continue;

      const firstController = this._left ?? this._right;
      if (firstController && controller.deviceId === firstController.deviceId) {
        this._setContent(
          this._stepHeading(index, total),
          "That's the same controller you already paired. Please try again.",
          [],
        );
        await new Promise(r => setTimeout(r, 2500));
        continue;
      }

      const confirmed = await this._confirmStep(controller, sideLabel, index, total);
      if (!confirmed) {
        await controller.disconnect();
        continue;
      }

      await controller.activate(this.options.connectionInterval);
      await this._calibrateStep(controller, sideLabel, index, total);

      if (side === 'left') this._left = controller;
      else this._right = controller;

      await this._pairedStep(sideLabel, index, total);
      return side;
    }
  }

  private _chooseSideStep(index: number, total: number): Promise<Side> {
    return new Promise(resolve => {
      this._setContent(
        this._stepHeading(index, total),
        total > 1
          ? 'Which controller do you want to pair first? Check the label on the top.'
          : 'Which controller do you want to pair? Check the label on the top.',
        [
          { label: 'Left Controller', onClick: () => resolve('left') },
          { label: 'Right Controller', onClick: () => resolve('right') },
        ],
      );
    });
  }

  private _connectStep(
    sideLabel: string,
    index: number,
    total: number,
    canStop: boolean,
  ): Promise<ZapboxController | null | typeof STOP> {
    return new Promise(resolve => {
      const buttons: ButtonDef[] = [{
        label: 'Ready to pair',
        primary: true,
        onClick: async () => {
          this._setContent(
            `Pairing ${sideLabel} controller — ${this._stepHeading(index, total)}`,
            'Choose your controller from the popup displayed by your browser.',
            [],
          );
          try {
            resolve(await ZapboxController.connect({ defer: true }));
          } catch {
            resolve(null);
          }
        },
      }];
      if (canStop) {
        const have = index - 1; // controllers already paired
        buttons.push({
          label: have === 0
            ? 'Continue without controllers'
            : `Continue with ${have} controller${have === 1 ? '' : 's'}`,
          onClick: () => resolve(STOP),
        });
      }
      this._setContent(
        `Pairing ${sideLabel} controller — ${this._stepHeading(index, total)}`,
        'Insert batteries and press A, B or Menu to wake the controller. The orange LED will flash when ready.',
        buttons,
      );
    });
  }

  private _confirmStep(controller: ZapboxController, sideLabel: string, index: number, total: number): Promise<boolean> {
    return new Promise(resolve => {
      this._setContent(
        this._stepHeading(index, total),
        `Connected to ${controller.deviceName}. To check this is the correct controller, please confirm the orange LED is now constantly on at low brightness.`,
        [
          { label: 'Yes, continue', primary: true, onClick: () => resolve(true) },
          { label: 'No, try again', onClick: () => resolve(false) },
        ],
      );
    });
  }

  private _calibrateStep(controller: ZapboxController, sideLabel: string, index: number, total: number): Promise<void> {
    this._setContent(
      `Calibrating ${sideLabel} controller — ${this._stepHeading(index, total)}`,
      'Place the controller on a flat, stationary surface to calibrate the motion sensors.',
      [],
    );
    return new Promise(resolve => {
      const handler = (_ev: CustomEvent<ControllerUpdate>) => {
        if (controller.isCalibrated) {
          controller.removeEventListener('update', handler);
          resolve();
        }
      };
      controller.addEventListener('update', handler);
    });
  }

  private _pairedStep(sideLabel: string, index: number, total: number): Promise<void> {
    const isFinal = index === total;
    const heading = isFinal ? 'Setup complete' : this._stepHeading(index, total);
    const message = isFinal && total > 1
      ? 'Both controllers paired successfully! 🎉'
      : `${sideLabel} controller paired successfully! 🎉`;

    // On the final step, an optional caller-supplied button both ends the flow on a clear note and
    // captures a fresh user gesture (so e.g. the WebXR shim can call requestSession off it instead
    // of needing its own "Enter VR" prompt). Intermediate steps just auto-advance.
    const finishLabel = this.options.finishButtonLabel;
    if (isFinal && finishLabel) {
      return new Promise(resolve => {
        this._setContent(heading, message, [
          { label: finishLabel, primary: true, onClick: () => resolve() },
        ]);
      });
    }

    this._setContent(heading, message, []);
    return new Promise(resolve => setTimeout(resolve, 1500));
  }

  private _stepHeading(index: number, total: number): string {
    return total > 1 ? `Controller ${index} of ${total}` : 'Controller setup';
  }

  private _createUI(): HTMLDivElement {
    const div = document.createElement('div');
    div.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      'background:rgba(10,10,15,0.97)',
      'color:#eee',
      'font-family:system-ui,sans-serif',
      'font-size:1rem',
      // No padding here: the logo band spans full width (for its divider) and the content
      // below carries its own padding. Bottom padding lives on the content wrapper.
      // Top + side borders with rounded top corners, so it reads as a panel sliding up over the page.
      'border:2px solid #888',
      'border-bottom:none',
      'border-radius:20px 20px 0 0',
      'z-index:999999',
      'box-sizing:border-box',
      // Start off-screen; slide in/out is driven in setup()/_teardownUI().
      'transform:translateY(100%)',
      `transition:transform ${UI_SLIDE_MS}ms ease`,
    ].join(';');

    // Full-width logo band: 0.5rem above and below the logo, with a divider underneath.
    const logo = document.createElement('div');
    logo.style.cssText = 'text-align:center;padding:0.5rem 0;border-bottom:2px solid #888;';
    logo.innerHTML = ZAPBOX_WORDMARK_SVG;
    const svg = logo.firstElementChild as SVGElement;
    svg.style.cssText = 'height:20px;width:auto;display:block;margin:0 auto;';
    div.appendChild(logo);

    // Padded content wrapper: 1rem above the header (below the divider), 2rem sides/bottom.
    const content = document.createElement('div');
    content.style.cssText = 'padding:1rem 2rem 2rem;';
    div.appendChild(content);

    this._headingEl = document.createElement('div');
    this._headingEl.style.cssText = 'font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:0.6rem;';
    content.appendChild(this._headingEl);

    this._bodyEl = document.createElement('p');
    this._bodyEl.style.cssText = 'margin:0 0 1.25rem;line-height:1.6;max-width:600px;';
    content.appendChild(this._bodyEl);

    this._buttonsRow = document.createElement('div');
    this._buttonsRow.style.cssText = 'display:flex;gap:0.75rem;flex-wrap:wrap;';
    content.appendChild(this._buttonsRow);

    return div;
  }

  private _setContent(heading: string, body: string, buttons: ButtonDef[]): void {
    if (!this._headingEl || !this._bodyEl || !this._buttonsRow) return;

    this._headingEl.textContent = heading;
    this._bodyEl.textContent = body;

    const row = this._buttonsRow;
    row.replaceChildren();
    for (const { label, onClick, primary } of buttons) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = [
        'padding:0.6rem 1.25rem',
        'border-radius:6px',
        `border:${primary ? 'none' : '1px solid #555'}`,
        `background:${primary ? '#2563eb' : '#2a2a2a'}`,
        'color:#fff',
        'font-family:inherit',
        'font-size:1rem',
        'cursor:pointer',
      ].join(';');
      btn.addEventListener('click', () => {
        for (const b of Array.from(row.querySelectorAll('button'))) {
          (b as HTMLButtonElement).disabled = true;
        }
        onClick();
      });
      row.appendChild(btn);
    }
  }
}
