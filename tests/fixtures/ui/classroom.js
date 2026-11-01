// What the classroom test renders: the whole Classroom, so a crash on screen
// (an effect, a render path no unit test walks) fails the test instead of
// reaching DSH's slot boundary.
export { Classroom } from '../../../src/ui/Classroom.jsx'
export { AppContext } from '../../../src/ui/hooks.js'
