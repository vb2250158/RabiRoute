# Button

Use `button` to create a clickable action, such as submitting a form, confirming a selection, or reloading content.

## Respond to a Tap

Use `bindtap` to bind a handler from the page:

```xml
<button bindtap="handleSubmit">Submit</button>
```

```javascript
export default {
  handleSubmit() {
    console.log('The user tapped Submit');
  }
};
```

The button centers its child content horizontally and vertically by default. Use CSS to define its background, border, and text color:

```css
button {
  padding: 12px 20px;
  color: #ffffff;
  background-color: #07c160;
  border-radius: 8px;
}
```

`button` does not add a component-specific touch animation. Add pressed feedback with styles that match your application.
