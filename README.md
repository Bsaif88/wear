# Wear

Phone-first wardrobe app. Photograph a piece, it finds the official product photo online, builds a closet library, and styles outfits from live weather and current fashion trends.

## Environment variables (set in Coolify)

| Name | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | From console.anthropic.com. Keep it as a secret. |
| `APP_PASSCODE` | yes | Passcode to open the app. Pick something long. |
| `FASHN_API_KEY` | no | Turns on "Try it on me" and photo cutouts. From app.fashn.ai/api (pay per image). |
| `TRYON_DAILY_STEPS` | no | Cap on garment try-on steps per 24h (default 40) to protect credits. |
| `TRYON_MODE` | no | `fast`, `balanced` (default) or `quality`. |
| `PLACE_NAME` / `PLACE_LAT` / `PLACE_LON` | no | Defaults to Safwa (26.65, 49.96). |
| `STYLE_FOR` | no | Default `men's`. |
| `CLAUDE_MODEL` | no | Default `claude-sonnet-5-5`. |

## Coolify settings

- Build pack: Dockerfile, port `3000`.
- Persistent storage: mount a volume at `/data` (closet photos and database live here).

TV mode: open `/#tv` (add `?occ=work` to pick the occasion).

## Credits

Virtual try-on and background removal use the FASHN API, following the request flow documented in [OpenTryOn](https://github.com/tryonlabs/opentryon) (CC BY-NC 4.0, TryOn Labs). Personal, non-commercial use.
