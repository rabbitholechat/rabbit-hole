import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
const buttonVariants = cva('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 shrink-0', {
  variants: {
    variant: { default: 'bg-primary text-white hover:bg-teal-800', outline: 'border border-border bg-white hover:bg-stone-50', ghost: 'hover:bg-stone-100 text-muted-foreground' },
    size: { default: 'h-10 px-4', sm: 'h-8 px-3 text-xs', icon: 'size-9' },
  }, defaultVariants: { variant: 'default', size: 'default' },
})
export function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}
