---
name: Chat Bridge
description: Bridge de chat Twitch-hub com identidade Taste HUD
colors:
  bg: "#050605"
  paper: "#d6ddc8"
  mute: "#5c6454"
  hot: "#ff6a1a"
  line: "#1c2018"
  ok: "#9fdf5a"
  err: "#ff5c4d"
typography:
  display:
    fontFamily: "Big Shoulders Display, Impact, sans-serif"
    fontSize: "clamp(3.5rem, 9vw, 6rem)"
    fontWeight: 800
    lineHeight: 0.85
    letterSpacing: "-0.02em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.7rem"
    fontWeight: 400
    letterSpacing: "0.08em"
rounded:
  none: "0"
spacing:
  sm: "0.65rem"
  md: "1.1rem"
  lg: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.hot}"
    textColor: "#111111"
    padding: "0.85rem 1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.paper}"
    padding: "0.85rem 1rem"
---

## Overview

Identidade visual padrão do Chat Bridge, derivada do first viewport **Taste Skill v2 · HUD · Identidade** (`Same face everywhere`). Fundo quase preto, placa paper com halftone, display monumental condensado, mono para UI, um único acento quente alerta.

## Colors

`--bg` tinta, `--paper` placa HUD, `--mute` secundário, `--hot` CTA e sinal. Sem roxo, sem gradientes decorativos multi-cor.

## Typography

Big Shoulders Display em headlines (uppercase, tracking fechado). JetBrains Mono em body de interface, labels e logs. Tipo em extremos: monumental ou tiny mono.

## Layout

Home assimétrica (rail + hero 4:5 + pitch). App (`/dashboard`, `/link`) em painéis de borda reta, sem cards arredondados.

## Elevation & Depth

Quase flat. Hero com leve rotação e padrão dither. Separação por hairlines `--line`.

## Shapes

Cantos retos. Sem pills.

## Components

Topbar mono, botões `.btn` / `.btn.primary`, painéis de plataforma, blocos de relay/logs, steps de vínculo.

## Do's and Don'ts

- Do: Twitch como hub na copy; CTAs para `/link` e streamer OAuth; acento único quente.
- Don't: purple mesh, cards iguais com radius, Inter/system-only, feature icon grids.
