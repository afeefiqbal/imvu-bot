import path from 'node:path'
import { fileURLToPath } from 'node:url'

import preset from '../../../../vendor/filament/filament/tailwind.config.preset'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..', '..', '..', '..')

export default {
    presets: [preset],
    content: [
        path.join(projectRoot, 'app/Filament/**/*.php'),
        path.join(projectRoot, 'resources/views/filament/**/*.blade.php'),
        path.join(projectRoot, 'vendor/filament/**/*.blade.php'),
    ],
}
