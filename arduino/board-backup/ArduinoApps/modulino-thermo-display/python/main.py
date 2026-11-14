from arduino.app_utils import App, Bridge


def on_temperature(celsius: float):
    print(f"Temperature: {celsius:.1f} C")


Bridge.provide("on_temperature", on_temperature)

App.run()
