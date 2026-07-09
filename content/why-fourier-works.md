---
title: Why Fourier Series Work
date: 2026-06-14
topic: analysis
excerpt: Sines and cosines are not just convenient — they are the eigenfunctions of the operator that physics keeps handing us. That is the whole secret.
---

Ask why we expand functions in sines and cosines rather than some other
family and the honest answer is: because differentiation likes them.
Each $e^{inx}$ is an eigenfunction of $\frac{d^2}{dx^2}$, so any linear
equation built from that operator falls apart into independent modes.

For a $2\pi$-periodic function the coefficients are just projections,

$$c_n = \frac{1}{2\pi}\int_{-\pi}^{\pi} f(x)\, e^{-inx}\, dx,$$

and orthogonality does the rest. Convergence is the delicate part of
the story — Dirichlet's conditions, Gibbs' overshoot at jumps — and the
part we take up next.
