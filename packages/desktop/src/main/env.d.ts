interface ImportMetaEnv {
  readonly OMP_CHANNEL: string
  readonly VITE_OMP_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
