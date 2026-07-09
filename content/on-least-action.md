---
title: On Least Action
date: 2026-06-28
topic: mechanics
excerpt: Nature is lazy in a very precise way. Of all the paths a particle could take, the one it does take makes a certain integral stationary — and everything else follows.
---

Newton tells you *how* a particle moves: write down the forces, solve
$F = ma$. The principle of least action tells you *why that motion and
no other*. Of all conceivable paths $q(t)$ between two fixed events, the
particle takes the one that makes the action

$$S[q] = \int_{t_1}^{t_2} L(q, \dot q, t)\, dt$$

stationary, where $L = T - V$ is the Lagrangian. Demanding
$\delta S = 0$ and integrating by parts gives the Euler–Lagrange
equation,

$$\frac{d}{dt}\frac{\partial L}{\partial \dot q} - \frac{\partial L}{\partial q} = 0,$$

which for $L = \tfrac{1}{2}m\dot q^2 - V(q)$ is exactly Newton's second
law. Same physics, but the bookkeeping is now coordinate-free — and the
door to Noether's theorem, and to quantum mechanics via the path
integral, is standing open.
