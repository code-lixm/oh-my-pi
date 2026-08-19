import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M2 2H14V6H2V2Z" fill="var(--icon-strong-base)" />
      <path d="M2 6H6V18H2V6Z" fill="var(--icon-base)" />
      <path d="M10 6H14V18H10V6Z" fill="var(--icon-weak-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M10 10H70V30H10V10Z" fill="var(--icon-strong-base)" />
      <path d="M10 30H30V90H10V30Z" fill="var(--icon-base)" />
      <path d="M50 30H70V90H50V30Z" fill="var(--icon-weak-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      aria-label="oh-my-pi"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M18 30H6V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--icon-base)" />
        <path d="M30 0H36V12H48V18H54V36H48V18H36V36H30V0Z" fill="var(--icon-base)" />
        <path d="M60 18H84V24H60V18Z" fill="var(--icon-base)" />
        <path d="M90 12H114V36H108V18H105V36H99V18H96V36H90V12Z" fill="var(--icon-base)" />
        <path d="M120 12H126V30H138V12H144V36H138V42H132V36H120V12Z" fill="var(--icon-strong-base)" />
        <path d="M150 18H174V24H150V18Z" fill="var(--icon-strong-base)" />
        <path d="M198 30H186V18H198V30Z" fill="var(--icon-weak-base)" />
        <path d="M186 30H198V12H186V30ZM204 36H186V42H180V6H204V36Z" fill="var(--icon-strong-base)" />
        <path d="M216 6H222V12H216V6ZM216 18H222V36H216V18Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
