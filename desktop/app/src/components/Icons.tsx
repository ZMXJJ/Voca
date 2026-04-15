import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function defaults(props: IconProps, size = 24): SVGProps<SVGSVGElement> {
  const { size: s = size, ...rest } = props;
  return { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...rest };
}

export function IconHome(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

export function IconArchive(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1.08z" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...defaults(props)} fill="currentColor" stroke="none">
      <polygon points="6,3 20,12 6,21" />
    </svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <svg {...defaults(props)} fill="currentColor" stroke="none">
      <rect x="5" y="3" width="5" height="18" rx="1" />
      <rect x="14" y="3" width="5" height="18" rx="1" />
    </svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconModel(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

export function IconMicrophone(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

export function IconSparkle(props: IconProps) {
  return (
    <svg {...defaults(props)} fill="currentColor" stroke="none">
      <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
      <path d="M18 14l1.18 3.54L22.72 19l-3.54 1.46L18 24l-1.18-3.54L13.28 19l3.54-1.46L18 14z" opacity="0.6" />
    </svg>
  );
}

export function IconSliders(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

export function IconHeart(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

type LogoProps = SVGProps<SVGSVGElement> & { height?: number };

export function IconVocaLogo(props: LogoProps) {
  const { height: h = 24, ...rest } = props;
  const aspect = 259 / 64;
  return (
    <svg width={h * aspect} height={h} viewBox="0 0 259 64" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...rest}>
      <path d="M225.559 64C220.013 64 214.978 62.592 210.455 59.776C206.018 56.96 202.477 53.163 199.831 48.384C197.271 43.52 195.991 38.101 195.991 32.128C195.991 26.069 197.271 20.651 199.831 15.872C202.477 11.008 206.018 7.168 210.455 4.352C214.978 1.451 220.013 0 225.559 0C230.253 0 234.391 1.024 237.975 3.072C241.645 5.035 244.546 7.765 246.679 11.264C248.813 14.763 249.879 18.731 249.879 23.168V40.832C249.879 45.269 248.813 49.237 246.679 52.736C244.631 56.235 241.773 59.008 238.103 61.056C234.434 63.019 230.253 64 225.559 64ZM227.863 50.688C233.069 50.688 237.25 48.939 240.407 45.44C243.65 41.941 245.271 37.461 245.271 32C245.271 28.331 244.546 25.088 243.095 22.272C241.645 19.456 239.597 17.28 236.951 15.744C234.391 14.123 231.362 13.312 227.863 13.312C224.45 13.312 221.421 14.123 218.775 15.744C216.215 17.28 214.167 19.456 212.631 22.272C211.181 25.088 210.455 28.331 210.455 32C210.455 35.669 211.181 38.912 212.631 41.728C214.167 44.544 216.215 46.763 218.775 48.384C221.421 49.92 224.45 50.688 227.863 50.688ZM244.375 62.72V46.208L246.807 31.232L244.375 16.384V1.28C249.874 1.28 252.957 1.28 258.455 1.28V62.72H244.375Z" />
      <path d="M168.274 64C162.215 64 156.711 62.592 151.762 59.776C146.898 56.96 143.058 53.12 140.242 48.256C137.426 43.392 136.018 37.973 136.018 32C136.018 25.941 137.426 20.523 140.242 15.744C143.058 10.88 146.898 7.04 151.762 4.224C156.711 1.408 162.215 0 168.274 0C173.053 0 177.49 0.939 181.586 2.816C185.767 4.608 189.309 7.211 192.21 10.624L182.994 19.968C181.202 17.835 179.026 16.256 176.466 15.232C173.991 14.123 171.261 13.568 168.274 13.568C164.775 13.568 161.661 14.379 158.93 16C156.285 17.536 154.194 19.669 152.658 22.4C151.207 25.131 150.482 28.331 150.482 32C150.482 35.584 151.207 38.784 152.658 41.6C154.194 44.331 156.285 46.507 158.93 48.128C161.661 49.664 164.775 50.432 168.274 50.432C171.261 50.432 173.991 49.92 176.466 48.896C179.026 47.787 181.202 46.165 182.994 44.032L192.21 53.376C189.309 56.789 185.767 59.435 181.586 61.312C177.49 63.104 173.053 64 168.274 64Z" />
      <path d="M97.301 64C91.328 64 85.909 62.592 81.045 59.776C76.181 56.875 72.298 52.992 69.397 48.128C66.581 43.264 65.173 37.845 65.173 31.872C65.173 25.899 66.581 20.523 69.397 15.744C72.298 10.965 76.181 7.168 81.045 4.352C85.909 1.451 91.328 0 97.301 0C103.36 0 108.821 1.408 113.685 4.224C118.549 7.04 122.389 10.88 125.205 15.744C128.106 20.523 129.557 25.899 129.557 31.872C129.557 37.845 128.106 43.264 125.205 48.128C122.389 52.992 118.549 56.875 113.685 59.776C108.821 62.592 103.36 64 97.301 64ZM97.301 50.432C100.8 50.432 103.872 49.664 106.517 48.128C109.248 46.507 111.338 44.288 112.789 41.472C114.325 38.656 115.093 35.456 115.093 31.872C115.093 28.288 114.325 25.131 112.789 22.4C111.253 19.669 109.162 17.536 106.517 16C103.872 14.379 100.8 13.568 97.301 13.568C93.888 13.568 90.816 14.379 88.085 16C85.44 17.536 83.349 19.669 81.813 22.4C80.362 25.131 79.637 28.288 79.637 31.872C79.637 35.456 80.362 38.656 81.813 41.472C83.349 44.288 85.44 46.507 88.085 48.128C90.816 49.664 93.888 50.432 97.301 50.432Z" />
      <path d="M28.032 62.72L0 1.28H15.616L36.992 51.328H27.776L49.28 1.28H64.256L36.224 62.72H28.032Z" />
    </svg>
  );
}
