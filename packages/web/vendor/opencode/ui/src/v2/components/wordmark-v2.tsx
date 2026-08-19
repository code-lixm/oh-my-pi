import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      aria-label="oh-my-pi"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <path opacity="0.7" d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="currentColor" />
            <path opacity="0.7" d="M30 0H36V12H48V18H54V36H48V18H36V36H30V0Z" fill="currentColor" />
            <path opacity="0.7" d="M60 18H84V24H60V18Z" fill="currentColor" />
            <path opacity="0.7" d="M90 12H114V36H108V18H105V36H99V18H96V36H90V12Z" fill="currentColor" />
            <path opacity="0.7" d="M120 12H126V30H138V12H144V36H138V42H132V36H120V12Z" fill="currentColor" />
            <path opacity="0.7" d="M150 18H174V24H150V18Z" fill="currentColor" />
            <path opacity="0.7" d="M186 30H198V12H186V30ZM204 36H186V42H180V6H204V36Z" fill="currentColor" />
            <path opacity="0.7" d="M216 6H222V12H216V6ZM216 18H222V36H216V18Z" fill="currentColor" />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="234" height="42">
          <rect width="234" height="42" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="117" y1="22" x2="117" y2="42" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
