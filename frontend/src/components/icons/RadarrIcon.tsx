// Radarr's own mark — the dark-UI variant it ships for its own interface
// (github.com/Radarr/Radarr, frontend/src/Content/Images/logo.svg), used
// with unmodified colors. The light variant in the repo's Logo/ folder is
// near-black and would disappear on Cortexarr's dark field.
export default function RadarrIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1025" className={className} xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(70 18)">
        <path
          d="M105.302 156.117L112.824 876.083C52.6511 883.662 7.52159 853.347 7.52159 792.719L0 194.01C0 4.54526 172.997 -40.9263 278.299 34.8596L812.332 345.582C887.548 398.632 902.591 497.154 864.983 565.361C857.461 512.311 834.897 481.996 789.767 451.682L188.04 110.646C142.91 80.3311 105.302 87.9097 105.302 156.117Z"
          fill="#FFFFFF"
        />
        <path
          d="M0 378.929C45.1296 394.087 90.2591 386.508 127.867 363.772L744.638 0C782.245 53.0501 774.724 106.1 729.594 136.415L210.605 439.558C135.389 477.451 37.608 439.558 0 378.929Z"
          transform="translate(60.1727 535.046)"
          fill="#FFFFFF"
        />
        <path d="M0 416.822L368.558 204.622L7.52159 0L0 416.822Z" transform="translate(240.6909 284.953)" fill="#FFC230" />
      </g>
    </svg>
  )
}
