/**
 * Maps for documentary shots: Web Mercator and the camera, the map data and
 * its gazetteer, facts from the World Factbook, the plan of a shot, and the
 * drawing both the editor and the export use. The motion kind "map"
 * (motion/templates/map.ts) is built on these.
 */
export * from './mercator'
export * from './geo'
export * from './gazetteer'
export * from './facts'
export * from './types'
export * from './spec'
export * from './labels'
export * from './camera'
export * from './paint'
export * from './sources'
export * from './shot'
export * from './plates'
export * from './tiles'
export * from './load'
export { mapLayers } from './layers'
