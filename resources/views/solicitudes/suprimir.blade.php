@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Suprimir los datos del titular')

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <p><a href="{{ route('arcop.solicitudes.show', $solicitud) }}">&larr; Volver a la solicitud</a></p>

    <h1>Suprimir y acoger</h1>

    @if ($advertencia)
        <p class="arcop-aviso arcop-aviso--atencion" role="note">{{ $advertencia }}</p>
    @endif

    @if ($previa)
        <section class="arcop-previa" aria-labelledby="previa-titulo">
            <h2 id="previa-titulo">Hasta dónde llega el derecho de esta persona</h2>
            {{-- Sale de evaluar() —que no escribe nada— y cita la norma y el
                 plazo: es lo que hay que copiar en el fundamento. --}}
            <p class="arcop-detalle">{{ $previa }}</p>
        </section>
    @endif

    <form method="POST" action="{{ route('arcop.solicitudes.suprimir.aplicar', $solicitud) }}" class="arcop-formulario">
        @csrf

        <div class="arcop-campo">
            <label for="fundamento">Fundamento de la resolución</label>
            <textarea id="fundamento" name="fundamento" rows="5" required
                      aria-describedby="fundamento-ayuda">{{ old('fundamento') }}</textarea>
            <p id="fundamento-ayuda" class="arcop-ayuda">Es lo que se le responde al titular.</p>
        </div>

        <button class="arcop-boton arcop-boton--grave" type="submit">Suprimir</button>
    </form>
@endsection
