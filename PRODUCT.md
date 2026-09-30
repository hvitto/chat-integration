# Chat Bridge

## Product
Bridge de chat multiplataforma: Twitch é o hub obrigatório; YouTube e Kick conectam-se via OAuth. Viewers vinculam identidades para mensagens aparecerem na Twitch com o nome nativo Twitch. Streamers ligam/desligam o relay no dashboard.

## Audience
Streamers em multistream e viewers que querem aparecer com o mesmo face/@Twitch em todas as salas.

## Surfaces
- `/` home (identidade Taste HUD · Same face everywhere)
- `/dashboard` painel do streamer (relay, conexões, link da audiência)
- `/link` vínculo de contas do viewer

## Visual
Padrão visual: Taste Skill v2 HUD Identidade. UI em **português do Brasil** (pt-BR). Ver `DESIGN.md`.

## Assumptions
- Exploração de landings `/landing` e atlas `/references` foram removidas após escolha da identidade.
- Plano de produto (hub, identity, relay) permanece; UI segue o padrão visual escolhido.
