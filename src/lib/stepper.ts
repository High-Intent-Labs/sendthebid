// Mobile-friendly +/- steppers for numeric inputs.
// Usage: wrap a number input in <div class="number-stepper"> ... </div> with
// .stepper-minus and .stepper-plus buttons, then call initSteppers() once
// on page load. The stepper reads step/min/max from the input's own attributes
// and dispatches an `input` event after each click so reactive listeners fire.

function snapToStep(value: number, step: number): number {
  // Clamp float drift to the step's decimal precision (e.g. step=0.5 → 1 dp)
  const decimals = (step.toString().split('.')[1] || '').length;
  return Number(value.toFixed(decimals));
}

export function initSteppers(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.number-stepper').forEach(wrap => {
    // Guard: prevent double-binding if initSteppers() runs more than once
    // (Astro script hoisting quirks, view transitions, hot reload).
    if (wrap.dataset.stepperWired) return;
    wrap.dataset.stepperWired = '1';

    const input = wrap.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) return;
    const step = parseFloat(input.step) || 1;
    const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
    const max = input.max !== '' ? parseFloat(input.max) : Infinity;

    const apply = (delta: number) => {
      // Per-wrapper 150 ms timestamp debounce. Catches any cause of
      // double-firing for a single user action: mobile ghost clicks,
      // touch→click duplication, synthetic events. 150 ms is well
      // under human rapid-tap cadence on a stepper (200-400 ms min
      // between real taps) but far above any synthetic re-fire
      // (typically <5 ms). Mini-split ran into this bug before
      // dropping steppers; the debounce is the safety net.
      const now = performance.now();
      const last = Number(wrap.dataset.stepperLast || '0');
      if (now - last < 150) return;
      wrap.dataset.stepperLast = String(now);
      const current = parseFloat(input.value) || 0;
      const next = snapToStep(Math.min(max, Math.max(min, current + delta)), step);
      input.value = String(next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    wrap.querySelector<HTMLButtonElement>('.stepper-minus')?.addEventListener('click', () => apply(-step));
    wrap.querySelector<HTMLButtonElement>('.stepper-plus')?.addEventListener('click', () => apply(step));
  });
}
