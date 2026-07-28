/* Compact inline SVG icon set — no icon library dependency. */
const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const svg = { width: 15, height: 15, viewBox: '0 0 24 24', 'aria-hidden': true } as const;

export const SendIcon = () => (
  <svg {...svg}><path {...p} d="M4 12l16-8-6 8 6 8z" /></svg>
);
export const StopIcon = () => (
  <svg {...svg}><rect {...p} x="6" y="6" width="12" height="12" rx="2" /></svg>
);
export const CopyIcon = () => (
  <svg {...svg}><rect {...p} x="9" y="9" width="11" height="11" rx="2" /><path {...p} d="M5 15V5a2 2 0 012-2h8" /></svg>
);
export const CheckIcon = () => (
  <svg {...svg}><path {...p} d="M4 12.5l5 5L20 6.5" /></svg>
);
export const ExternalIcon = () => (
  <svg {...svg}><path {...p} d="M14 4h6v6M20 4l-9 9" /><path {...p} d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></svg>
);
export const CodeIcon = () => (
  <svg {...svg}><path {...p} d="M8 6l-5 6 5 6M16 6l5 6-5 6" /></svg>
);
export const PlayIcon = () => (
  <svg {...svg}><path {...p} d="M7 4.5l12 7.5-12 7.5z" /></svg>
);
export const RefreshIcon = () => (
  <svg {...svg}><path {...p} d="M20 11a8 8 0 10-2.3 6M20 5v6h-6" /></svg>
);
export const CloseIcon = () => (
  <svg {...svg}><path {...p} d="M6 6l12 12M18 6L6 18" /></svg>
);
export const ZoomIcon = () => (
  <svg {...svg}><circle {...p} cx="11" cy="11" r="6.5" /><path {...p} d="M16 16l4.5 4.5M8.5 11h5M11 8.5v5" /></svg>
);
export const BookIcon = () => (
  <svg {...svg}><path {...p} d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" /><path {...p} d="M8 7h7M8 11h7" /></svg>
);
export const SparkIcon = () => (
  <svg {...svg}><path {...p} d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" /></svg>
);
export const ToolIcon = () => (
  <svg {...svg}><path {...p} d="M14.5 3.5a5 5 0 00-6.2 6.2L3 15v6h6l5.3-5.3a5 5 0 006.2-6.2l-3.2 3.2-3-3z" /></svg>
);
export const BoltIcon = () => (
  <svg {...svg}><path {...p} d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg>
);
export const AlertIcon = () => (
  <svg {...svg}><path {...p} d="M12 3l9.5 17h-19z" /><path {...p} d="M12 9v5M12 17.2v.1" /></svg>
);
export const TrashIcon = () => (
  <svg {...svg}><path {...p} d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
);
