import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge conditional + conflicting Tailwind classes safely. */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
