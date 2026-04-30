import {
  confirm as inqConfirm,
  input as inqInput,
  password as inqPassword,
  select as inqSelect,
} from '@inquirer/prompts'

/**
 * Thin façade over `@inquirer/prompts`. Lets tests inject a fake `Prompter`
 * without touching stdin, and isolates the rest of the wizard from inquirer's
 * surface — so a future swap (to e.g. `prompts`) stays a one-file change.
 *
 * Methods mirror inquirer's signatures but accept only the shape we use.
 */
export type Prompter = {
  text(opts: { message: string; default?: string }): Promise<string>
  password(opts: { message: string; mask?: boolean }): Promise<string>
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>
  select<T extends string>(opts: {
    message: string
    choices: ReadonlyArray<{ name: string; value: T; description?: string }>
    default?: T
  }): Promise<T>
}

export const interactivePrompter: Prompter = {
  text: ({ message, default: def }) => inqInput({ message, default: def }),
  password: ({ message, mask }) => inqPassword({ message, mask: mask ?? true }),
  confirm: ({ message, default: def }) => inqConfirm({ message, default: def ?? false }),
  select: ({ message, choices, default: def }) =>
    inqSelect({
      message,
      choices: choices.map((c) => ({ name: c.name, value: c.value, description: c.description })),
      default: def,
    }),
}

/** Throws if the wizard tries to prompt — used by --non-interactive. */
export const noPrompter: Prompter = {
  text: () => {
    throw new Error('non-interactive mode: text prompt not allowed')
  },
  password: () => {
    throw new Error('non-interactive mode: password prompt not allowed')
  },
  confirm: () => {
    throw new Error('non-interactive mode: confirm prompt not allowed')
  },
  select: () => {
    throw new Error('non-interactive mode: select prompt not allowed')
  },
}
