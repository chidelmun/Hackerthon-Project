const glsl = require('glslify')
const mat4 = require('gl-mat4')
const simplex = new (require('simplex-noise'))()
const random = require('random-spherical/array')()
const createPlane = require('primitive-plane')

const RADIUS = 256
const COUNT = RADIUS * RADIUS
const MODEL_SCALE = 1
const ROTATE_SPEED = 0.0
const PASS_DIVISOR = 32
const POINT_RADIUS = 0.3
const INITIAL_SPEED = -POINT_RADIUS / 100
const PARTICLE_UP = 0.2;
const REFLECTION_DAMPING = 0.6
const GROUND_OFFSET = `vec3(0.0, 0.2, 0.2)`;
const POINT_SIZE = '5.0'
const GROUND_FN = name => `
  ${name}.x * ${name}.x +
  ${name}.z * ${name}.z +
  0.01 * sin(20.0 * ${name}.x + tick * 0.2)
`
const GROUND_DFDX = name => `2.0 * ${name}.x`
const GROUND_DFDZ = name => `2.0 * ${name}.z`

module.exports = function (regl) {
  const initialPositions = Array(COUNT).fill().map((n, i) => {
    const point = random(Math.sqrt(Math.random()) * POINT_RADIUS)
    point[1] += 0.1
    point[2] += 0.2
    return point
  })
  const state = Array(3).fill().map((n, pass) => (
    regl.framebuffer({
      color: regl.texture({
        radius: RADIUS,
        data: (() => {
          const buffer = new Float32Array(COUNT * 4)
          const target = []
          for (let i = 0; i < COUNT; i++) {
            const position = initialPositions[i]
            buffer[i * 4 + 0] = position[0]
            buffer[i * 4 + 1] = position[1] + pass * INITIAL_SPEED + PARTICLE_UP
            buffer[i * 4 + 2] = position[2]
            buffer[i * 4 + 3] = 0
          }
          return buffer
        })(),
        wrap: 'repeat',
        type: 'float'
      }),
      colorType: 'float',
      depthStencil: false
    })
  ))

  const updatePositions = regl({
    vert: glsl`
      precision highp float;
      attribute vec2 position;
      varying vec2 uv;
      void main() {
        uv = 0.5 * (position + 1.0);
        gl_Position = vec4(position, 0, 1);
      }
    `,
    frag: glsl`
      precision highp float;

      uniform sampler2D currState, prevState;
      uniform float tick, passStep;
      varying vec2 uv;

      float PI = ${Math.PI};


      void main() {
        vec3 prevPositionA = texture2D(prevState, uv).rgb;
        vec3 currPositionA = texture2D(currState, uv).rgb;
        vec3 deltaPositionA = currPositionA - prevPositionA;
        vec3 directionA = normalize(deltaPositionA);
        float distanceA = length(deltaPositionA);

        vec3 fluidForce = vec3(0.0);

        vec3 velocity = deltaPositionA + vec3(0.0, -0.00005, 0.0);
        vec3 position = currPositionA + velocity;

        vec3 groundIn = position + ${GROUND_OFFSET};
        float groundY = ${GROUND_FN('groundIn')};
        if (groundIn.y < groundY && abs(position.x) < 0.45 && abs(position.z) < 0.45) {
          float dfdx = ${GROUND_DFDX('groundIn')};
          float dfdz = ${GROUND_DFDZ('groundIn')};
          vec3 floorNormal = normalize(vec3(-dfdx, 1.0, -dfdz));

          position = currPositionA + ${REFLECTION_DAMPING.toFixed(1)}
            * reflect(velocity, floorNormal);

          position.y += max(0.0, groundY - ${GROUND_OFFSET}.y - position.y);
        }


        gl_FragColor = vec4(position, 1);
      }
    `,
    attributes: {
      position: [ -4, -4, 4, -4, 0, 4 ]
    },
    uniforms: {
      prevState: ({tick}) => state[tick % 3],
      currState: ({tick}) => state[(tick + 1) % 3],
      passStep: ({tick}) => tick % 2,
      tick: ({tick}) => tick,
    },
    depth: { enable: false },
    count: 3,
    framebuffer: ({tick}) => state[(tick + 2) % 3]
  })

  const drawParticles = regl({
    vert: glsl`
      precision highp float;
      uniform mat4 projView, model;
      uniform float viewportHeight;
      uniform sampler2D currState;
      uniform sampler2D prevState;
      uniform float time;

      varying vec3 vColor;

      float TAU = 6.283185307179586;

      attribute vec2 coordinate;
      attribute float id;

      void main () {
        vec4 currPosition = texture2D(currState, coordinate);
        vec4 prevPosition = texture2D(prevState, coordinate);
        // float speed = distance(currPosition, prevPosition);
        float speed = (prevPosition.y - currPosition.y);
        currPosition.w = 1.0;
        gl_PointSize = ${POINT_SIZE};
        gl_Position = projView * model * currPosition;
        vColor = mix(
          vec3(0.3, 1.0, 0.7),
          vec3(1.0, 0.3, 0.3),
          clamp(speed * 500.0, 0.0, 1.0)
        ) * mix(0.5, 1.0, mod(id, 10.0) * 0.1);
      }
    `,
    frag: glsl`
      precision highp float;
      varying vec3 vColor;

      void main () {
        gl_FragColor = vec4(vColor, 1.0);
      }
    `,
    attributes: {
      coordinate: Array(COUNT * 2).fill(0).map((n, i) => [
        (i % RADIUS) / RADIUS,
        Math.floor(i / RADIUS) / RADIUS
      ]),
      id: Array(COUNT).fill(0).map((n, i) => i)
    },
    count: COUNT,
    uniforms: {
      prevState: ({tick}) => state[tick % 3],
      currState: ({tick}) => state[(tick + 1) % 3],
      viewportHeight: ({viewportHeight}) => viewportHeight,
      model: (() => {
        const scale = mat4.scale([], mat4.identity([]), [MODEL_SCALE, MODEL_SCALE, MODEL_SCALE])
        const output = []
        return ({time}) => mat4.rotateY(output, scale, +time * ROTATE_SPEED - 1.5)
      })()
    },
    primitive: 'points'
  })

  const drawParametricSurface = createDrawParametricSurface(regl)

  return () => {
    updatePositions()
    drawParticles()
    drawParametricSurface()
  }
}

function createDrawParametricSurface (regl) {
  const mesh = createPlane(0.9, 0.9, 50, 50)
  mesh.positions.forEach(p => {
    const [x, y, z] = p
    p[0] = x
    p[1] = z
    p[2] = y
  })

  return regl({
    vert: glsl`
      precision highp float;
      attribute vec3 normal, position;
      uniform mat4 model, projView;
      uniform float tick;
      varying float vGround;

      void main() {
        vec3 groundIn = position + ${GROUND_OFFSET};
        float groundY = ${GROUND_FN('groundIn')};
        vGround = groundY;

        gl_Position = projView * model * vec4(position.x, groundY - 0.21, position.z, 1.0);
      }
    `,
    frag: glsl`
      precision highp float;
      varying float vGround;

      void main() {
        gl_FragColor = vec4(vec3(0.5, 0.5, 0.5) * vGround + 0.2, 1.0);
      }
    `,
    attributes: {
      position: mesh.positions
    },
    elements: mesh.cells,
    uniforms: {
      model: (() => {
        const scale = mat4.scale([], mat4.identity([]), [MODEL_SCALE, MODEL_SCALE, MODEL_SCALE])
        const output = []
        return ({time}) => mat4.rotateY(output, scale, +time * ROTATE_SPEED - 1.5)
      })()
    }
  })
}
